import { Composition } from 'remotion';
import { Film } from './Film';
import { DURATION, FPS, H, W } from './lib/time';

export function RemotionRoot() {
  return <Composition id="Film" component={Film} durationInFrames={DURATION} fps={FPS} width={W} height={H} />;
}
