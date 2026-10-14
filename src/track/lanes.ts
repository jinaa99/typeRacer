/**
 * Maps characters to one of four lanes by keyboard zone (QWERTY), so each
 * lane roughly corresponds to a group of fingers:
 *   lane 0: ` 1 2 3  q w e  a s d  z x c
 *   lane 1: 4 5      r t    f g    v b
 *   lane 2: 6 7      y u    h j    n m
 *   lane 3: 8 9 0 - =  i o p [ ] \  k l ; '  , . /
 * Shifted characters use the lane of their unshifted key. Space has no lane.
 */
export const LANE_COUNT = 4;
export const SPACE_LANE = -1;

const LANE_KEYS = ['`123qweasdzxc', '45rtfgvb', '67yuhjnm', "890-=iop[]\\kl;',./"];
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED = "`1234567890-=[]\\;',./";

const laneByChar = new Map<string, number>();
LANE_KEYS.forEach((keys, lane) => {
  for (const key of keys) {
    laneByChar.set(key, lane);
    laneByChar.set(key.toUpperCase(), lane);
  }
});
[...SHIFTED].forEach((char, i) => laneByChar.set(char, laneByChar.get(UNSHIFTED[i])!));

export function laneForChar(char: string): number {
  if (char === ' ') return SPACE_LANE;
  return laneByChar.get(char) ?? char.charCodeAt(0) % LANE_COUNT;
}
