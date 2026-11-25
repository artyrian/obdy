// Native app (Capacitor) helpers. On the web these are never loaded: window.Capacitor is absent.
export const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();

const lazy = (f) => { let p; return () => (p ??= f()); };
const share = lazy(() => import("@capacitor/share"));
const fs = lazy(() => import("@capacitor/filesystem"));
const awake = lazy(() => import("@capacitor-community/keep-awake"));

export async function nativeTransport(log) {
  const { NativeBleTransport } = await import("./transport/ble-native.js");
  return new NativeBleTransport(log);
}

/** Write text to the cache dir and open the share sheet with the file. */
export async function shareFile(name, text) {
  const { Filesystem, Directory, Encoding } = await fs();
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  const { Share } = await share();
  await Share.share({ title: name, files: [uri] });
}

export async function shareText(title, text) {
  const { Share } = await share();
  await Share.share({ title, text });
}

export async function keepAwake(on) {
  const { KeepAwake } = await awake();
  await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
}
