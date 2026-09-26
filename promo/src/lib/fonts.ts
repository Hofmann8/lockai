import { continueRender, delayRender, staticFile } from 'remotion';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

/** 中文字体（Noto Sans / Serif SC 可变字体）和拉丁字体都加载完才开始出帧 */
const handle = delayRender('fonts');
const faces = [
  new FontFace('Noto Sans SC', `url(${staticFile('fonts/NotoSansSC-VF.ttf')})`, { weight: '100 900' }),
  new FontFace('Noto Serif SC', `url(${staticFile('fonts/NotoSerifSC-VF.ttf')})`, { weight: '200 900' }),
];
Promise.all(faces.map((f) => f.load()))
  .then((loaded) => {
    loaded.forEach((f) => document.fonts.add(f));
    const probes = [
      '400 20px "Fraunces Variable"', 'italic 400 20px "Fraunces Variable"', '400 20px "Geist Variable"',
      '600 20px "Geist Variable"', '400 20px "Geist Mono Variable"',
    ];
    return Promise.all(probes.map((p) => document.fonts.load(p, 'LockAI 1.0')));
  })
  .then(() => document.fonts.ready)
  .then(() => continueRender(handle))
  .catch((err) => {
    console.error('font load failed', err);
    continueRender(handle);
  });
