// The one place where the desktop browser and the Android app differ. Everything else is shared code.
// In a browser, a file is saved by "downloading" it. Inside the Android app (Capacitor's WebView) downloads do not
// work, so the file is written to the phone's Documents folder with the Filesystem plugin and offered to the share sheet.
export const isNative = () => !!window.Capacitor?.isNativePlatform?.();

export async function saveFile(blob, name) {
  if (!isNative()) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return name;
  }
  const { Filesystem, Share } = window.Capacitor.Plugins;
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
  const saved = await Filesystem.writeFile({ path: `MixAndLearn/${name}`, data, directory: "DOCUMENTS", recursive: true });
  try { await Share.share({ title: name, url: saved.uri }); } catch { /* the user closed the share sheet */ }
  return saved.uri;
}
