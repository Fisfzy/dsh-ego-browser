const BTBN_TAG = "autobuild-2026-08-17-13-05";
const BTBN_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const STATIC_BASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";

export const FFMPEG_MANIFEST = Object.freeze({
  "win32-x64": Object.freeze({
    provider: "btbn", buildId: BTBN_TAG, archiveType: "tar", size: 170641412,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-win64-gpl.zip`,
    sha256: "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299",
    executableName: "ffmpeg.exe", archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i,
  }),
  "win32-arm64": Object.freeze({
    provider: "btbn", buildId: BTBN_TAG, archiveType: "tar", size: 116275753,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-winarm64-gpl.zip`,
    sha256: "451d181c0774f19dc7c30711911f3aad4f4ee4feb1cecb7b5efc1b895e093c67",
    executableName: "ffmpeg.exe", archiveExecutable: /(?:^|\/)bin\/ffmpeg\.exe$/i,
  }),
  "linux-x64": Object.freeze({
    provider: "btbn", buildId: BTBN_TAG, archiveType: "tar", size: 127977972,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linux64-gpl.tar.xz`,
    sha256: "646080fba1f295446fdf35fbdd4bad6ab934a30f9fcb86f3e96ad50eaff06c82",
    executableName: "ffmpeg", archiveExecutable: /(?:^|\/)bin\/ffmpeg$/,
  }),
  "linux-arm64": Object.freeze({
    provider: "btbn", buildId: BTBN_TAG, archiveType: "tar", size: 109615592,
    url: `${BTBN_BASE}/ffmpeg-N-126188-g426841da9d-linuxarm64-gpl.tar.xz`,
    sha256: "7cda2218fe0107e449631eb6b850146a4522ebf4ed13733010d0aada9858b119",
    executableName: "ffmpeg", archiveExecutable: /(?:^|\/)bin\/ffmpeg$/,
  }),
  "darwin-x64": Object.freeze({
    provider: "evermeet", buildId: "ffmpeg-static-b6.1.1", archiveType: "gzip", size: 25296431,
    url: `${STATIC_BASE}/ffmpeg-darwin-x64.gz`,
    sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    executableName: "ffmpeg",
  }),
  "darwin-arm64": Object.freeze({
    provider: "osxexperts", buildId: "ffmpeg-static-b6.1.1", archiveType: "gzip", size: 19246198,
    url: `${STATIC_BASE}/ffmpeg-darwin-arm64.gz`,
    sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    executableName: "ffmpeg",
  }),
});

export function platformManifest(platform = process.platform, arch = process.arch) {
  return FFMPEG_MANIFEST[`${platform}-${arch}`] || null;
}

export function rewriteGithubUrl(url, mirror = "") {
  if (!mirror || !url.startsWith("https://github.com/")) return url;
  let parsed;
  try { parsed = new URL(mirror); }
  catch { throw codedError("ffmpeg-mirror-invalid", "GitHub mirror must be a valid HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw codedError("ffmpeg-mirror-invalid", "GitHub mirror must be an HTTPS base URL without credentials, query, or fragment");
  }
  const base = parsed.toString().replace(/\/+$/, "");
  return `${base}${url.slice("https://github.com".length)}`;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
