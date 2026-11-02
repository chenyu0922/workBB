// workBB-Guard — C# 单文件版（.NET Framework，Windows 自带运行时，体积小）
//
// 编译：用系统自带 csc.exe
//   csc /target:winexe /platform:anycpu /optimize+ /out:workbb-guard.exe Guard.cs
//
// 为什么另做一个 C# 版：
//   Node SEA 版本受 node.exe 体积拖累（~90 MB），不适合做常驻/分发工具。
//   C# 版只依赖 Windows 自带的 .NET Framework（Win10+ 默认已装），
//   产物通常 20-40 KB，可直接分发、可开机自启。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace WorkBBGuard
{
    internal static class Program
    {
        private const string Version = "1.0.0";
        private const string SettingKey = "startupForceAutoUpdate";
        private const string ConfigEnv = "WORKBUDDY_CONFIG_DIR";

        // ---------- 路径 ----------

        private static string ConfigDir()
        {
            var e = Environment.GetEnvironmentVariable(ConfigEnv);
            if (!string.IsNullOrWhiteSpace(e)) return e.Trim();
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".workbuddy");
        }

        private static string StateFile() => Path.Combine(ConfigDir(), "workbb", "state.json");
        private static string SettingsFile() => Path.Combine(ConfigDir(), "settings.json");

        // ---------- 极简 JSON（只处理我们需要的两种结构）----------
        // 不引入任何依赖，用字符串级读写；对 settings.json 采用
        // 「精确插入/删除一个布尔键」的方式，避免重排用户其他字段。

        private static bool HasAutoUpdateOff(string json)
        {
            // 匹配 "startupForceAutoUpdate" : false
            var idx = json.IndexOf("\"" + SettingKey + "\"", StringComparison.Ordinal);
            if (idx < 0) return false;
            var rest = json.Substring(idx);
            var colon = rest.IndexOf(':');
            if (colon < 0) return false;
            var after = rest.Substring(colon + 1).TrimStart();
            return after.StartsWith("false", StringComparison.Ordinal);
        }

        /// <summary>确保 settings.json 的顶层有 "startupForceAutoUpdate": false。</summary>
        private static string EnsureAutoUpdateOff(string json)
        {
            var idx = json.IndexOf("\"" + SettingKey + "\"", StringComparison.Ordinal);
            if (idx >= 0)
            {
                // 已存在：把值替换成 false
                var rest = json.Substring(idx);
                var colon = rest.IndexOf(':');
                int vstart = idx + colon + 1;
                int p = vstart;
                while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
                int end;
                if (json[p] == 't' || json[p] == 'f')
                {
                    while (p < json.Length && (char.IsLetter(json[p]))) p++;
                    end = p;
                }
                else if (json[p] == '"')
                {
                    p++;
                    while (p < json.Length && json[p] != '"') { if (json[p] == '\\') p++; p++; }
                    p++;
                    end = p;
                }
                else
                {
                    return json; // 结构不认识，放弃改动
                }
                return json.Substring(0, vstart) + " false" + json.Substring(end);
            }

            // 不存在：插到最后一个 } 之前
            var close = json.LastIndexOf('}');
            if (close < 0) return json;
            var before = json.Substring(0, close).TrimEnd();
            var sep = before.EndsWith("{") ? "" : ",";
            var ins = sep + "\n  \"" + SettingKey + "\": false\n";
            return before + ins + json.Substring(close);
        }

        /// <summary>删除顶层 "startupForceAutoUpdate" 键（恢复官方默认）。</summary>
        private static string RemoveAutoUpdateKey(string json)
        {
            var idx = json.IndexOf("\"" + SettingKey + "\"", StringComparison.Ordinal);
            if (idx < 0) return json;

            // 向前找到该键前面的逗号（若有）
            int b = idx - 1;
            while (b >= 0 && char.IsWhiteSpace(json[b])) b--;
            int start = idx;
            int removeTrailingComma = -1;
            if (b >= 0 && json[b] == ',') start = b;

            // 向后跳过值
            var rest = json.Substring(idx);
            var colon = rest.IndexOf(':');
            int p = idx + colon + 1;
            while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
            if (p < json.Length && (json[p] == 't' || json[p] == 'f'))
                while (p < json.Length && char.IsLetter(json[p])) p++;
            else if (p < json.Length && json[p] == '"')
            {
                p++;
                while (p < json.Length && json[p] != '"') { if (json[p] == '\\') p++; p++; }
                p++;
            }
            // 若 start 停在逗号前（说明它是第一个键之后），则连带后面的逗号一起删
            int q = p;
            while (q < json.Length && char.IsWhiteSpace(json[q])) q++;
            if (start == idx && q < json.Length && json[q] == ',') p = q + 1;

            return json.Substring(0, start) + json.Substring(p);
        }

        // ---------- 文件原子写 ----------

        private static void AtomicWrite(string path, string content)
        {
            var dir = Path.GetDirectoryName(path);
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var tmp = path + "." + Process.GetCurrentProcess().Id + "." + DateTime.Now.Ticks + ".tmp";
            File.WriteAllText(tmp, content, new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        // ---------- L1 官方开关 ----------

        private static bool DisableAutoUpdate(out string info)
        {
            var fp = SettingsFile();
            if (!File.Exists(fp)) { info = "settings.json 不存在"; return false; }
            var json = File.ReadAllText(fp, Encoding.UTF8);
            if (HasAutoUpdateOff(json)) { info = "已经是 false（无需改动）"; return true; }
            var bak = fp + ".workbb-guard-bak";
            if (!File.Exists(bak)) File.Copy(fp, bak);
            AtomicWrite(fp, EnsureAutoUpdateOff(json));
            info = fp;
            return true;
        }

        private static bool RestoreAutoUpdate(out string info)
        {
            var fp = SettingsFile();
            if (!File.Exists(fp)) { info = "settings.json 不存在"; return false; }
            var json = File.ReadAllText(fp, Encoding.UTF8);
            if (json.IndexOf("\"" + SettingKey + "\"", StringComparison.Ordinal) < 0)
            {
                info = "本来就没有该键";
                return true;
            }
            AtomicWrite(fp, RemoveAutoUpdateKey(json));
            info = fp;
            return true;
        }

        // ---------- L2 缓存拦阻 ----------

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetDriveTypeW(string lpRootPathName);

        private static string ResolveAppName()
        {
            var cands = new List<string>();
            var ap = Environment.GetEnvironmentVariable("WORKBUDDY_APP_PATH");
            if (!string.IsNullOrWhiteSpace(ap))
                cands.Add(Path.Combine(ap.Trim(), "app.asar.unpacked", "cli", "product.json"));
            var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "WorkBuddy", "resources", "app.asar.unpacked", "cli", "product.json");
            cands.Add(local);
            cands.Add(@"C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\product.json");
            cands.Add(@"C:\Program Files (x86)\WorkBuddy\resources\app.asar.unpacked\cli\product.json");

            foreach (var f in cands)
            {
                try
                {
                    if (!File.Exists(f)) continue;
                    var s = File.ReadAllText(f, Encoding.UTF8);
                    var k = s.IndexOf("\"applicationName\"", StringComparison.Ordinal);
                    if (k < 0) continue;
                    var c = s.IndexOf(':', k);
                    var q1 = s.IndexOf('"', c + 1);
                    var q2 = s.IndexOf('"', q1 + 1);
                    var name = s.Substring(q1 + 1, q2 - q1 - 1).Trim();
                    if (name.Length > 0) return name;
                }
                catch { }
            }
            return "workbuddy";
        }

        private static string NormName(string n)
        {
            var sb = new StringBuilder();
            foreach (var ch in (n ?? "workbuddy").ToLowerInvariant())
            {
                if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '_' || ch == '-')
                    sb.Append(ch);
                else sb.Append('-');
            }
            var s = sb.ToString().Trim('-');
            return s.Length == 0 ? "workbuddy" : s;
        }

        private static string[] CacheDirs()
        {
            var norm = NormName(ResolveAppName());
            var temp = Path.GetTempPath();
            return new[]
            {
                Path.Combine(temp, "workbuddy-update-x64-" + norm),
                Path.Combine(temp, "workbuddy-update-arm64-" + norm),
                Path.Combine(temp, "workbuddy-update-ia32-" + norm),
            };
        }

        /// <summary>判断目录是否已被拦阻（兼容 Node 版符号链接 + C# 版占位文件两种形态）。</summary>
        private static bool IsBlockedDir(string target)
        {
            try
            {
                // 形态二：C# 占位文件（内容以 workBB-Guard: 开头）
                var fi = new FileInfo(target);
                if (fi.Exists)
                {
                    try
                    {
                        var txt = File.ReadAllText(target, Encoding.UTF8);
                        return txt.StartsWith("workBB-Guard:", StringComparison.Ordinal);
                    }
                    catch { return false; }
                }

                // 形态一：Node 符号链接（指向 *.workbb-blocked 且该目标不存在）
                var di = new DirectoryInfo(target);
                if (di.Exists)
                {
                    if ((di.Attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        var rp = Path.Combine(Path.GetDirectoryName(target),
                            Path.GetFileName(target) + ".workbb-blocked");
                        return !Directory.Exists(rp) && !File.Exists(rp);
                    }
                    return false;
                }
                return false;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>把目录变成「无法创建」的占位。用同名的只读文件占位，
        /// 比符号链接更稳（不依赖开发者模式/权限）。</summary>
        private static string BlockDir(string target)
        {
            if (File.Exists(target))
            {
                var t0 = File.ReadAllText(target);
                return t0.StartsWith("workBB-Guard:", StringComparison.Ordinal) ? "already-blocked" : "foreign-file";
            }
            if (Directory.Exists(target))
            {
                // 已是指向 *.workbb-blocked 的符号链接（Node 版建的）→ 视为已拦阻
                try
                {
                    var di = new DirectoryInfo(target);
                    if ((di.Attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        var linkTarget = Path.Combine(Path.GetDirectoryName(target),
                            Path.GetFileName(target) + ".workbb-blocked");
                        if (!Directory.Exists(linkTarget)) return "already-blocked";
                    }
                }
                catch { }

                var bak = target + ".workbb-bak-" + DateTime.Now.Ticks;
                try
                {
                    Directory.Move(target, bak);
                }
                catch (Exception e)
                {
                    return "move-failed: " + e.Message;
                }
                File.WriteAllText(target, "workBB-Guard: update cache dir blocked\n");
                return "moved-and-blocked";
            }
            var dir = Path.GetDirectoryName(target);
            if (dir != null && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(target, "workBB-Guard: update cache dir blocked\n");
            return "blocked";
        }

        private static string UnblockDir(string target)
        {
            // C# 版占位文件
            if (File.Exists(target))
            {
                try
                {
                    var txt = File.ReadAllText(target);
                    if (!txt.StartsWith("workBB-Guard:", StringComparison.Ordinal)) return "foreign-file";
                    File.Delete(target);
                }
                catch (Exception e)
                {
                    return "delete-failed: " + e.Message;
                }
            }
            else if (Directory.Exists(target))
            {
                // Node 版符号链接
                try
                {
                    var di = new DirectoryInfo(target);
                    if ((di.Attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        var linkTarget = Path.Combine(Path.GetDirectoryName(target),
                            Path.GetFileName(target) + ".workbb-blocked");
                        if (!Directory.Exists(linkTarget))
                        {
                            Directory.Delete(target, false); // 删链接本身，不动目标
                        }
                        else return "foreign-link";
                    }
                    else return "not-blocked";
                }
                catch (Exception e)
                {
                    return "unlink-failed: " + e.Message;
                }
            }
            else return "not-blocked";

            var dir = Path.GetDirectoryName(target);
            var pref = Path.GetFileName(target) + ".workbb-bak-";
            if (dir != null && Directory.Exists(dir))
            {
                foreach (var d in Directory.GetDirectories(dir, pref + "*"))
                {
                    try { Directory.Move(d, target); break; }
                    catch { }
                }
            }
            return "unblocked";
        }

        private static List<string> PurgeInstallers()
        {
            var removed = new List<string>();
            foreach (var d in CacheDirs())
            {
                if (!Directory.Exists(d)) continue;
                foreach (var sub in new[] { "", "pending" })
                {
                    var p = sub.Length == 0 ? d : Path.Combine(d, sub);
                    if (!Directory.Exists(p)) continue;
                    foreach (var f in Directory.GetFiles(p))
                    {
                        var n = Path.GetFileName(f).ToLowerInvariant();
                        if (n == "installer.exe" || n.EndsWith(".nsis") || n == "update-info.json" || n.EndsWith(".blockmap"))
                        {
                            try { File.Delete(f); removed.Add(f); } catch { }
                        }
                    }
                }
            }
            return removed;
        }

        // ---------- L3 自愈 ----------

        private static string ReadStateRaw()
        {
            try { return File.Exists(StateFile()) ? File.ReadAllText(StateFile(), Encoding.UTF8) : null; }
            catch { return null; }
        }

        private static string JsonStr(string json, string key)
        {
            var k = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (k < 0) return null;
            var c = json.IndexOf(':', k);
            var q1 = json.IndexOf('"', c);
            if (q1 < 0) return null;
            var q2 = json.IndexOf('"', q1 + 1);
            if (q2 < 0) return null;
            return json.Substring(q1 + 1, q2 - q1 - 1);
        }

        private static string Sha256(string fp)
        {
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(fp))
            {
                var h = sha.ComputeHash(fs);
                var sb = new StringBuilder();
                foreach (var b in h) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private const int STEP_MISS = 0;
        private const int STEP_OK = 1;

        private static int Heal()
        {
            var st = ReadStateRaw();
            if (st == null)
            {
                Console.WriteLine("  · 跳过：没有 workbb 状态文件（先跑 workbb apply）");
                return STEP_MISS;
            }
            var mode = JsonStr(st, "mode");
            if (mode != "mirror")
            {
                Console.WriteLine("  · 跳过：未处于 mirror 模式（mode=" + mode + "）");
                return STEP_MISS;
            }
            var target = JsonStr(st, "targetDir");
            var source = JsonStr(st, "sourceDir");
            if (target == null || !File.Exists(Path.Combine(target, "workbuddy-prompt.tpl")))
            {
                Console.WriteLine("  · 跳过：镜像目录缺失");
                return STEP_MISS;
            }
            if (source == null || !Directory.Exists(source))
            {
                Console.WriteLine("  · 跳过：源模板目录不可达（安装体路径变了？）");
                return STEP_MISS;
            }

            // 漂移检测：从状态文件里抠 sourceFingerprint 的每个 sha256，逐文件比对
            int drift = 0;
            var pos = 0;
            while (true)
            {
                var i = st.IndexOf("\"sha256\"", pos, StringComparison.Ordinal);
                if (i < 0) break;
                // 找同一对象里的 "file"
                var fIdx = st.LastIndexOf("\"file\"", i, StringComparison.Ordinal);
                if (fIdx < 0) { pos = i + 8; continue; }
                var file = JsonStr(st.Substring(fIdx, i - fIdx + 10), "file");
                var hash = JsonStr(st.Substring(i, Math.Min(200, st.Length - i)), "sha256");
                pos = i + 8;
                if (file == null || hash == null) continue;
                var fp = Path.Combine(source, file);
                if (!File.Exists(fp)) { drift++; Console.WriteLine("    " + file + " — missing"); continue; }
                if (Sha256(fp) != hash) { drift++; Console.WriteLine("    " + file + " — changed"); }
            }

            if (drift == 0) Console.WriteLine("  源模板无变化");
            else Console.WriteLine("! 检测到 " + drift + " 个源模板变化（疑似官方升级）");

            return STEP_OK;
        }

        // ---------- 命令 ----------

        private static void Banner()
        {
            Console.WriteLine();
            Console.WriteLine("  ┌──────────────────────────────────────────────┐");
            Console.WriteLine("  │  workBB-Guard " + Version + " (C#)   WorkBuddy 升级屏蔽  │");
            Console.WriteLine("  └──────────────────────────────────────────────┘");
            Console.WriteLine();
        }

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            var cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "status";

            switch (cmd)
            {
                case "install":
                    {
                        Banner();
                        string info;
                        if (DisableAutoUpdate(out info))
                            Console.WriteLine("✓ 官方开关已关闭 -> " + info);
                        else
                            Console.WriteLine("✗ " + info);

                        foreach (var d in CacheDirs())
                        {
                            var r = BlockDir(d);
                            Console.WriteLine("✓ 缓存拦阻 " + r + "  " + d);
                        }
                        var purged = PurgeInstallers();
                        if (purged.Count > 0)
                        {
                            Console.WriteLine("✓ 清理了 " + purged.Count + " 个待安装升级包");
                            foreach (var p in purged) Console.WriteLine("    " + p);
                        }
                        Console.WriteLine();
                        Console.WriteLine("  请完全退出 WorkBuddy（含托盘）再启动，开关才生效。");
                        Console.WriteLine();
                        return 0;
                    }
                case "uninstall":
                case "remove":
                    {
                        Banner();
                        string info;
                        if (RestoreAutoUpdate(out info))
                            Console.WriteLine("✓ 官方开关已恢复 -> " + info);
                        foreach (var d in CacheDirs())
                            Console.WriteLine("✓ 解除拦阻 " + UnblockDir(d) + "  " + d);
                        Console.WriteLine();
                        return 0;
                    }
                case "purge":
                    {
                        Banner();
                        var p = PurgeInstallers();
                        Console.WriteLine(p.Count > 0 ? "✓ 清理了 " + p.Count + " 个升级包" : "· 没有需要清理的升级包");
                        foreach (var f in p) Console.WriteLine("  " + f);
                        Console.WriteLine();
                        return 0;
                    }
                case "status":
                    {
                        Banner();
                        var fp = SettingsFile();
                        var off = false;
                        if (File.Exists(fp))
                        {
                            var j = File.ReadAllText(fp, Encoding.UTF8);
                            off = HasAutoUpdateOff(j);
                        }
                        Console.WriteLine("  官方开关 " + SettingKey + ": " + (off ? "已关闭（屏蔽生效）" : "未关闭"));
                        Console.WriteLine("    " + fp);
                        Console.WriteLine();
                        Console.WriteLine("  更新缓存目录：");
                        foreach (var d in CacheDirs())
                        {
                            var blocked = IsBlockedDir(d);
                            var exists = Directory.Exists(d) || File.Exists(d);
                            var mark = blocked ? "✓ 已拦阻" : exists ? "· 存在未拦阻" : "· 不存在";
                            Console.WriteLine("    " + mark + "  " + d);
                        }
                        Console.WriteLine();
                        var st = ReadStateRaw();
                        if (st == null)
                            Console.WriteLine("  升级自愈: 未启用（先跑 workbb apply）");
                        else
                        {
                            var mode = JsonStr(st, "mode");
                            var td = JsonStr(st, "targetDir");
                            var ready = td != null && File.Exists(Path.Combine(td, "workbuddy-prompt.tpl"));
                            Console.WriteLine("  升级自愈: " + (mode == "mirror" ? (ready ? "就绪" : "镜像缺失") : "未启用（mode=" + mode + "）"));
                            if (td != null) Console.WriteLine("    " + td);
                        }
                        Console.WriteLine();
                        return 0;
                    }
                case "heal":
                    {
                        Banner();
                        Heal();
                        Console.WriteLine();
                        Console.WriteLine("  注意：C# 版只做检测；补齐补丁请跑 workbb / node bin/workbb.js guard heal");
                        Console.WriteLine();
                        return 0;
                    }
                case "watch":
                    {
                        Banner();
                        var iv = args.Length > 1 ? int.Parse(args[1]) : 60;
                        Console.WriteLine("  守护模式：每 " + iv + "s 保活屏蔽（Ctrl+C 退出）");
                        Console.WriteLine();
                        while (true)
                        {
                            var now = DateTime.Now.ToString("HH:mm:ss");
                            var fp = SettingsFile();
                            if (File.Exists(fp))
                            {
                                var j = File.ReadAllText(fp, Encoding.UTF8);
                                if (!HasAutoUpdateOff(j))
                                {
                                    string info;
                                    DisableAutoUpdate(out info);
                                    Console.WriteLine(now + " ✓ 开关被重置，已重新关闭");
                                }
                            }
                            foreach (var d in CacheDirs())
                                if (!IsBlockedDir(d) && !File.Exists(d))
                                {
                                    BlockDir(d);
                                    Console.WriteLine(now + " ✓ 缓存拦阻被破坏，已重建 " + d);
                                }
                            var p = PurgeInstallers();
                            if (p.Count > 0) Console.WriteLine(now + " ! 清理了 " + p.Count + " 个新下载的升级包");
                            Thread.Sleep(iv * 1000);
                        }
                    }
                case "autostart":
                    {
                        Banner();
                        var on = args.Length > 1 && (args[1].ToLowerInvariant() == "on" || args[1] == "1");
                        var exePath = Process.GetCurrentProcess().MainModule.FileName;
                        using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                            @"Software\Microsoft\Windows\CurrentVersion\Run", true))
                        {
                            if (key == null)
                            {
                                Console.WriteLine("✗ 打不开 Run 注册表键");
                                return 1;
                            }
                            if (on)
                            {
                                key.SetValue("workBB-Guard", "\"" + exePath + "\" watch 60");
                                Console.WriteLine("✓ 已设置开机自启（守护模式，每 60s）");
                                Console.WriteLine("    " + exePath);
                            }
                            else
                            {
                                try { key.DeleteValue("workBB-Guard", false); } catch { }
                                Console.WriteLine("✓ 已关闭开机自启");
                            }
                        }
                        Console.WriteLine();
                        return 0;
                    }
                case "version":
                case "-v":
                    Console.WriteLine("workBB-Guard " + Version + " (C#)");
                    return 0;
                default:
                    Banner();
                    Console.WriteLine("用法:");
                    Console.WriteLine("  workbb-guard install       安装屏蔽（官方开关 + 缓存拦阻 + 清包）");
                    Console.WriteLine("  workbb-guard uninstall     完整还原");
                    Console.WriteLine("  workbb-guard status        查看状态");
                    Console.WriteLine("  workbb-guard watch [秒]    守护模式：持续保活屏蔽");
                    Console.WriteLine("  workbb-guard autostart on|off  开机自启（守护模式）");
                    Console.WriteLine("  workbb-guard purge         清理已下载的升级包");
                    Console.WriteLine("  workbb-guard heal          检测官方升级（重打请用 workbb guard heal）");
                    Console.WriteLine();
                    return 0;
            }
        }
    }
}
