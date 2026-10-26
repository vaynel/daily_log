import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const sampleVideo = fileURLToPath(new URL('../video-spike/out/sample.mp4', import.meta.url));

// No dotenv, database connection, OAuth, or network calls in preflight.
export async function preflight(env = process.env, video = sampleVideo) {
  const source = await stat(video).catch(() => null);
  return {
    mode: 'PREFLIGHT_ONLY', realUploadEnabled: false,
    database: { result: 'NOT_RUN', reason: env.DATABASE_URL ? 'INJECTED_DATABASE_NOT_PROBED' : 'DATABASE_URL_MISSING' },
    source: { result: source?.isFile() && source.size > 0 && source.size <= 5_000_000 ? 'PASS' : 'NOT_RUN', reason: !source?.isFile() ? 'SYNTHETIC_VIDEO_MISSING' : source.size <= 0 || source.size > 5_000_000 ? 'VIDEO_SIZE_OUT_OF_RANGE' : 'SIZE_CHECK_ONLY' },
    oauth: { result: 'NOT_RUN', reason: 'PERSONAL_LOGIN_AND_DRIVE_FILE_CONSENT_NOT_VERIFIED' },
    actualGoogleDrive: { result: 'NOT_RUN', reason: 'DISABLED_IN_TASK_101' },
    actualAndroid: { result: 'NOT_RUN', reason: 'NO_DEVICE_TEST' },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.log(JSON.stringify({ result: 'NOT_RUN', reason: 'PREFLIGHT_ACCEPTS_NO_UPLOAD_FLAGS' }));
    process.exitCode = 2;
  } else console.log(JSON.stringify(await preflight(), null, 2));
}
