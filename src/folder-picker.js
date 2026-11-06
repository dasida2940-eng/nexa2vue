'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

// Fixed script: the initial folder comes in through an env var, never by
// string interpolation, so nothing user-supplied reaches the command line.
const PICKER_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# Explorer-style folder dialog (IFileOpenDialog + FOS_PICKFOLDERS): address bar,
# quick access and search, like the Windows file dialogs. The old tree-only
# FolderBrowserDialog is kept as a fallback if this one cannot be created.
$source = @'
using System;
using System.Runtime.InteropServices;
public static class Nexa2VueFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(IntPtr owner, string title, string initial) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
    uint options;
    dialog.GetOptions(out options);
    // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800);
    if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!String.IsNullOrEmpty(initial)) {
      try {
        IShellItem folder;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
        dialog.SetFolder(folder);
      } catch (Exception) { }
    }
    int hr = dialog.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // cancelled
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
$initial = $env:NEXA2VUE_INITIAL_DIR
if (-not ($initial -and (Test-Path -LiteralPath $initial -PathType Container))) { $initial = '' }
# Node starts this process hidden (SW_HIDE), and Windows applies that to the
# first window shown. A throwaway first Show/Hide consumes it, then a visible,
# transparent, topmost owner brings the dialog to the front with a taskbar entry.
$owner = New-Object System.Windows.Forms.Form
$owner.Text = $env:NEXA2VUE_PICK_TITLE
$owner.StartPosition = 'CenterScreen'
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.Show(); $owner.Hide(); $owner.Show()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()
$modern = $true
try { Add-Type -TypeDefinition $source -ErrorAction Stop } catch { $modern = $false }
if ($modern) {
  $selected = [Nexa2VueFolderDialog]::Pick($owner.Handle, $env:NEXA2VUE_PICK_DESC, $initial)
  if ($selected) { [Console]::Out.Write($selected) }
} else {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $env:NEXA2VUE_PICK_DESC
  $dialog.ShowNewFolderButton = $env:NEXA2VUE_PICK_NEWFOLDER -eq '1'
  if ($initial) { $dialog.SelectedPath = $initial }
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
}
$owner.Close()
$owner.Dispose()
`;

const PICK_TIMEOUT_MS = 10 * 60 * 1000;

const PURPOSES = {
  input: { title: 'nexa2vue 입력 폴더 선택', description: '변환할 넥사크로 화면(.xfdl)이 들어 있는 폴더를 선택하세요', newFolder: false },
  output: { title: 'nexa2vue 출력 폴더 선택', description: '변환 결과(Vue)를 저장할 폴더를 선택하세요', newFolder: true },
  frontend: { title: 'nexa2vue frontend 경로 선택', description: 'frontend 프로젝트 폴더(src/components가 있는 폴더)를 선택하세요', newFolder: false },
  backend: { title: 'nexa2vue backend 경로 선택', description: 'backend 프로젝트 폴더(src/main/java가 있는 폴더)를 선택하세요', newFolder: false },
  skill: { title: 'nexa2vue 변환 규칙 스킬 폴더 선택', description: '스킬 폴더(또는 스킬이 여러 개 든 폴더)를 선택하세요', newFolder: false },
};

/**
 * Show the native Windows folder dialog on this PC.
 * purpose: a key of PURPOSES. Resolves to the selected absolute path, or null when cancelled.
 */
function pickFolder(initialDir, purpose = 'input') {
  const texts = PURPOSES[purpose] || PURPOSES.input;
  if (process.platform !== 'win32') {
    return Promise.reject(Object.assign(new Error('이 OS에서는 폴더 선택 창을 지원하지 않습니다. 경로를 직접 입력하세요'), { status: 501 }));
  }
  const encoded = Buffer.from(PICKER_SCRIPT, 'utf16le').toString('base64');
  const env = {
    ...process.env,
    NEXA2VUE_INITIAL_DIR: initialDir && fs.existsSync(initialDir) ? initialDir : '',
    NEXA2VUE_PICK_TITLE: texts.title,
    NEXA2VUE_PICK_DESC: texts.description,
    NEXA2VUE_PICK_NEWFOLDER: texts.newFolder ? '1' : '0',
  };
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env, encoding: 'utf8', windowsHide: true, timeout: PICK_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          reject(Object.assign(new Error(`폴더 선택 창을 열 수 없습니다: ${err.message}`), { status: 500 }));
          return;
        }
        const selected = String(stdout || '').trim();
        resolve(selected || null);
      },
    );
  });
}

module.exports = { pickFolder, PICK_PURPOSES: Object.keys(PURPOSES) };
