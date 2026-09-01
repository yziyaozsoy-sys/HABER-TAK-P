Copy-Item main.js main.js.backup -Force

$keepLines = (Get-Content main.js -Encoding UTF8)[0..1533]

$cleanBlock = @'
async function checkKeywordsInBackground(silent) {
  const tracked = readTracked();
  if (!tracked.keywords || tracked.keywords.length === 0) return;

  const sources = readSources();
  if (!sources || sources.length === 0) return;

  const newMatches = [];

  function isWholeWordMatch(text, keyword) {
    const kw = keyword.toLocaleLowerCase('tr-TR').trim();
    if (!kw) return false;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-zçğıöşü0-9])${escaped}([^a-zçğıöşü0-9]|$)`, 'i');
    return regex.test(text);
  }

  for (const src of sources) {
    try {
      const feed = await fetchAndParseRSS(ensureProtocol(src.url));
      if (!feed || !feed.items) continue;

      feed.items.forEach((item) => {
        const titleLower = (item.title || "").toLocaleLowerCase('tr-TR');
        const matchedKeyword = tracked.keywords.find((kw) => isWholeWordMatch(titleLower, kw));

        if (!matchedKeyword) return;
        if (tracked.seenLinks.includes(item.link)) return;

        tracked.seenLinks.push(item.link);
        newMatches.push({
          title: item.title,
          link: item.link,
          sourceName: src.name,
          matchedKeyword
        });
      });
    } catch (e) {
      logToFile("Arka plan tarama hatasi (" + src.url + "): " + e.message);
    }
  }

  if (tracked.seenLinks.length > 2000) tracked.seenLinks = tracked.seenLinks.slice(-2000);
  writeTracked(tracked);

  if (!silent && newMatches.length > 0) {
    const matchesByKeyword = {};
    newMatches.forEach((m) => {
      if (!matchesByKeyword[m.matchedKeyword]) {
        matchesByKeyword[m.matchedKeyword] = [];
      }
      matchesByKeyword[m.matchedKeyword].push(m);
    });

    const BATCH_THRESHOLD = 5;
    const notificationsToShow = [];

    Object.entries(matchesByKeyword).forEach(([keyword, items]) => {
      if (items.length >= BATCH_THRESHOLD) {
        for (let i = 0; i < items.length; i += BATCH_THRESHOLD) {
          const group = items.slice(i, i + BATCH_THRESHOLD);
          const titles = group.map((g) => "• " + g.title).join("\n");

          notificationsToShow.push({
            title: `🔔 "${keyword}" - ${group.length} yeni haber`,
            body: titles
          });
        }
      } else {
        items.forEach((m) => {
          notificationsToShow.push({
            title: `🔔 "${m.matchedKeyword}" eslesmesi: ${m.sourceName}`,
            body: m.title
          });
        });
      }
    });

    notificationsToShow.forEach((n, index) => {
      setTimeout(() => {
        try {
          const notif = new Notification({
            title: n.title,
            body: n.body,
            icon: path.join(__dirname, "assets", "icon.ico")
          });
          notif.on("click", () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.send("tray-refresh");
            }
          });
          notif.show();
        } catch (e) {
          logToFile("Bildirim gosterme hatasi: " + e.message);
        }
      }, index * 1500);
    });

    logToFile(
      `Arka plan taramasi: ${newMatches.length} yeni eslesen haber bulundu ` +
      `(${notificationsToShow.length} bildirim gonderildi).`
    );
  } else {
    logToFile(`Arka plan taramasi calisti. Eslesen yeni haber: ${newMatches.length}`);
  }
}

function startBackgroundTracking() {
  logToFile("Arka plan takip sistemi baslatiliyor. Interval: " + (BG_TRACK_CHECK_MS / 1000) + " sn.");

  checkKeywordsInBackground(isFirstBackgroundCheck).catch((err) => {
    logToFile("Ilk arka plan taramasi hatasi: " + err.message);
  });
  isFirstBackgroundCheck = false;

  if (backgroundTrackTimer) {
    clearInterval(backgroundTrackTimer);
  }

  backgroundTrackTimer = setInterval(() => {
    checkKeywordsInBackground(false).catch((err) => {
      logToFile("Arka plan taramasi hatasi (interval): " + err.message);
    });
  }, BG_TRACK_CHECK_MS);
}
'@

$finalContent = ($keepLines -join "`r`n") + "`r`n" + $cleanBlock

Set-Content -Path main.js -Value $finalContent -Encoding UTF8

Write-Host "Dosya basariyla yeniden yazildi. Yeni satir sayisi:"
(Get-Content main.js).Count
