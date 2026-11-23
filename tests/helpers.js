// Test helpers: deterministic RNG and a reference model of the Web Audio spec's panner math.

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l === 0 ? a : scale(a, 1 / l);
};

/**
 * Azimuth in degrees exactly as the Web Audio spec computes it for a PannerNode
 * ("Azimuth and Elevation" section). Positive = source to the listener's RIGHT.
 * HRTF and equal-power panning both use this value, so if it is correct the browser won't mirror.
 */
export function webAudioAzimuth(listenerPos, forward, up, sourcePos) {
  const sl = sub(sourcePos, listenerPos);
  if (sl.x === 0 && sl.y === 0 && sl.z === 0) return 0;
  const sourceListener = norm(sl);
  const listenerRight = norm(cross(forward, up));
  const listenerForward = norm(forward);
  const upN = cross(listenerRight, listenerForward);
  const upProjection = dot(sourceListener, upN);
  const projected = norm(sub(sourceListener, scale(upN, upProjection)));
  let azimuth = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, dot(projected, listenerRight))));
  const frontBack = dot(projected, listenerForward);
  if (frontBack < 0) azimuth = 360 - azimuth;
  if (azimuth >= 0 && azimuth <= 270) azimuth = 90 - azimuth;
  else azimuth = 450 - azimuth;
  return azimuth;
}

/** Spec equal-power panning gains for a mono input at the given azimuth (degrees). */
export function equalPowerGains(azimuthDeg) {
  let az = Math.max(-180, Math.min(180, azimuthDeg));
  if (az < -90) az = -180 - az;
  else if (az > 90) az = 180 - az;
  const x = (az + 90) / 180;
  return { left: Math.cos((x * Math.PI) / 2), right: Math.sin((x * Math.PI) / 2) };
}

/** Audio stub that records every call. */
export function recordingAudio() {
  const calls = [];
  const rec = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    setDog: rec('setDog'), setListener: rec('setListener'), bark: rec('bark'), footstep: rec('footstep'),
    bump: rec('bump'), treeBump: rec('treeBump'), startCue: rec('startCue'), endCue: rec('endCue'), winJingle: rec('winJingle'),
    setForest: rec('setForest'), ambientStart: rec('ambientStart'), ambientStop: rec('ambientStop'),
    ambientEvent: rec('ambientEvent'), setAmbientMuted: rec('setAmbientMuted'),
  };
}
