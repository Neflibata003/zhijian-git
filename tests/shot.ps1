param([string]$out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rt,B;}}
"@
[W]::SetProcessDPIAware()|Out-Null
$p=Get-Process paper-git -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Select-Object -First 1
$r=New-Object W+R;[W]::GetWindowRect($p.MainWindowHandle,[ref]$r)|Out-Null
$bmp=New-Object System.Drawing.Bitmap ($r.Rt-$r.L),($r.B-$r.T)
$g=[System.Drawing.Graphics]::FromImage($bmp);$dc=$g.GetHdc();[W]::PrintWindow($p.MainWindowHandle,$dc,2)|Out-Null;$g.ReleaseHdc($dc)
$bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
