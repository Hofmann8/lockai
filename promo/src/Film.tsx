import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Opening } from './scenes/Opening';
import { Ask, ASK_END, ASK_START } from './scenes/Ask';
import { Campbell, CAMPBELL_END, CAMPBELL_START, CAMPBELL_WIPE, PairWipe } from './scenes/Campbell';
import { Dispatch, DISPATCH_END, DISPATCH_START, DISPATCH_WIPE } from './scenes/Dispatch';
import { Make, MAKE_END, MAKE_START } from './scenes/Make';
import { Finale, FINALE_END, FINALE_START } from './scenes/Finale';
import { bf } from './lib/time';
import { Lyrics } from './ui/lyric';

/** 转场用的两道竖线，叠在所有镜头之上（全局帧） */
function Transitions() {
  const frame = useCurrentFrame();
  return (
    <>
      <PairWipe frame={frame} start={CAMPBELL_WIPE} />
      <PairWipe frame={frame} start={DISPATCH_WIPE} lineColor="oklch(0.3 0.015 60)" />
    </>
  );
}

export function Film() {
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Sequence from={0} durationInFrames={bf(32) + 1} name="开场">
        <Opening />
      </Sequence>
      <Sequence from={ASK_START} durationInFrames={ASK_END - ASK_START} name="提问与理解">
        <Ask />
      </Sequence>
      <Sequence from={CAMPBELL_START} durationInFrames={CAMPBELL_END - CAMPBELL_START} name="Campbell">
        <Campbell />
      </Sequence>
      <Sequence from={DISPATCH_START} durationInFrames={DISPATCH_END - DISPATCH_START} name="派活">
        <Dispatch />
      </Sequence>
      <Sequence from={MAKE_START} durationInFrames={MAKE_END - MAKE_START} name="做出来">
        <Make />
      </Sequence>
      <Sequence from={FINALE_START} durationInFrames={FINALE_END - FINALE_START} name="高潮与收尾">
        <Finale />
      </Sequence>
      <Sequence name="转场">
        <Transitions />
      </Sequence>
      <Sequence name="歌词">
        <Lyrics />
      </Sequence>
      <Audio src={staticFile('audio/score.wav')} />
    </AbsoluteFill>
  );
}
