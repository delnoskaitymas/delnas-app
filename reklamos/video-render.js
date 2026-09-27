// Sugeneruoja MP4 iš HTML animacijos:
//   node reklamos/video-render.js                       → video.html
//   node reklamos/video-render.js video2.html delnas-reels-draugems-1080x1920.mp4
// Reikia Playwright ir ffmpeg su libx264 (pvz. `pip install imageio-ffmpeg`;
// kelią galima nurodyti FFMPEG aplinkos kintamuoju).
const path = require('path'), fs = require('fs'), { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const FPS = 30, DUR = 15;
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const src = process.argv[2] || 'video.html';
const out = path.join(__dirname, 'video', process.argv[3] || 'delnas-reels-1080x1920.mp4');
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'delnas-frames-'));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.goto('file://' + path.join(__dirname, src));
  await page.evaluate(() => document.fonts.ready);
  const N = FPS * DUR;
  for (let f = 0; f < N; f++) {
    await page.evaluate(t => window.renderAt(t), f / FPS);
    await page.screenshot({ path: path.join(tmp, String(f).padStart(4, '0') + '.jpg'), type: 'jpeg', quality: 92 });
    if (f % 60 === 0) console.log(`kadras ${f}/${N}`);
  }
  await browser.close();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Tylus garso takelis — kai kurios platformos geriau priima video su audio;
  // muziką pridėk pačioje Instagram/TikTok programėlėje (licencijuota biblioteka).
  execFileSync(ffmpeg, ['-y', '-framerate', String(FPS), '-i', path.join(tmp, '%04d.jpg'),
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-crf', '18',
    '-preset', 'slow', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', out], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✓', out);
})();
