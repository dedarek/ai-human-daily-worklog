import AppKit
import ApplicationServices
import Darwin
import ServiceManagement
import WebKit

private let worklogPort = ProcessInfo.processInfo.environment["WORKLOG_PORT"] ?? "4318"
private let serverBase = URL(string: "http://127.0.0.1:\(worklogPort)")!

@main
final class WorklogApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    static func main() {
        let application = NSApplication.shared
        let delegate = WorklogApp()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }

    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
    private var pauseMenuItem: NSMenuItem!
    private var todayMenuItem: NSMenuItem!
    private var loginItemMenuItem: NSMenuItem!
    private var service: Process?
    private var window: NSWindow?
    private var pollTimer: Timer?
    private var capturePaused = false
    private var todayURL = ""
    private var serverReady = false
    private var serviceToken = ""
    private var instanceLockFD: Int32 = -1
    private var launchingService = false
    private var nextRestartAt = Date.distantPast

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard acquireInstanceLock() else { NSApp.terminate(nil); return }
        installBundledHelpers()
        buildMenu()
        migrateLegacyLaunchAgent()
        serviceToken = (try? String(contentsOf: dataURL.appendingPathComponent("service-token"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        startServiceIfNeeded()
        configureLoginItem()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshStatus() }
        refreshStatus(openSetupWhenReady: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        if let service, service.isRunning { service.terminate() }
        if instanceLockFD >= 0 { flock(instanceLockFD, LOCK_UN); close(instanceLockFD) }
    }

    private func acquireInstanceLock() -> Bool {
        try? FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
        instanceLockFD = Darwin.open(dataURL.appendingPathComponent("menu-app.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        return instanceLockFD >= 0 && flock(instanceLockFD, LOCK_EX | LOCK_NB) == 0
    }

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.title = "W"
            button.font = .boldSystemFont(ofSize: 14)
            button.toolTip = "Worklog"
        }
        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "正在启动 Worklog…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "打开 Worklog", action: #selector(openDashboard), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "首次设置…", action: #selector(openSetup), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "立即生成今天日报", action: #selector(generateToday), keyEquivalent: "g"))
        todayMenuItem = NSMenuItem(title: "打开今天的飞书文档", action: #selector(openToday), keyEquivalent: "d")
        todayMenuItem.isEnabled = false
        menu.addItem(todayMenuItem)
        pauseMenuItem = NSMenuItem(title: "暂停采集", action: #selector(toggleCapture), keyEquivalent: "p")
        menu.addItem(pauseMenuItem)
        menu.addItem(.separator())
        loginItemMenuItem = NSMenuItem(title: "登录时自动启动", action: #selector(toggleLoginItem), keyEquivalent: "")
        menu.addItem(loginItemMenuItem)
        menu.addItem(NSMenuItem(title: "退出 Worklog", action: #selector(quit), keyEquivalent: "q"))
        menu.items.filter { $0.action != nil }.forEach { $0.target = self }
        statusItem.menu = menu
    }

    private var resourceURL: URL { Bundle.main.resourceURL! }
    private var dataURL: URL {
        if let override = ProcessInfo.processInfo.environment["WORKLOG_DATA_DIR"], !override.isEmpty { return URL(fileURLWithPath: override, isDirectory: true) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Worklog", isDirectory: true)
    }

    private func installBundledHelpers() {
        let target = dataURL.appendingPathComponent("bin", isDirectory: true)
        try? FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dataURL.path)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: target.path)
        for name in ["teams-audio-status", "system-audio-capture", "permission-status"] {
            let source = resourceURL.appendingPathComponent("bin/\(name)")
            let destination = target.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: source.path) else { continue }
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.copyItem(at: source, to: destination)
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        }
    }

    private func migrateLegacyLaunchAgent() {
        guard worklogPort == "4318", ProcessInfo.processInfo.environment["WORKLOG_DISABLE_LEGACY_MIGRATION"] != "1" else { return }
        let agents = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        let legacy = agents.appendingPathComponent("com.local.mac-worklog-feishu.plist")
        guard FileManager.default.fileExists(atPath: legacy.path) else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["bootout", "gui/\(getuid())", legacy.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run(); process.waitUntilExit()
            if process.terminationStatus == 0 {
                let backup = agents.appendingPathComponent("com.local.mac-worklog-feishu.plist.migrated")
                try? FileManager.default.removeItem(at: backup)
                try? FileManager.default.moveItem(at: legacy, to: backup)
            }
        } catch { NSLog("Worklog legacy migration: \(error)") }
    }

    private func startServiceIfNeeded() {
        request(path: "/api/status") { [weak self] result in
            if case .success = result { self?.serverReady = true; self?.refreshStatus() }
            else { self?.launchBundledService() }
        }
    }

    private func launchBundledService() {
        guard !launchingService, service?.isRunning != true else { return }
        launchingService = true
        nextRestartAt = Date().addingTimeInterval(10)
        let node = resourceURL.appendingPathComponent("runtime/node")
        let root = resourceURL.appendingPathComponent("server", isDirectory: true)
        let entry = root.appendingPathComponent("dist/server.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: entry.path) else {
            launchingService = false; updateStatus("安装包缺少后台组件", healthy: false)
            return
        }
        let process = Process()
        process.executableURL = node
        process.arguments = [entry.path]
        process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["WORKLOG_DATA_DIR"] = dataURL.path
        environment["WORKLOG_PORT"] = worklogPort
        serviceToken = UUID().uuidString
        try? FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
        try? serviceToken.write(to: dataURL.appendingPathComponent("service-token"), atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dataURL.appendingPathComponent("service-token").path)
        environment["WORKLOG_DESKTOP_TOKEN"] = serviceToken
        environment["WORKLOG_BUNDLED_LARK_CLI"] = root.appendingPathComponent("node_modules/@larksuite/cli/scripts/run.js").path
        let whisper = resourceURL.appendingPathComponent("bin/whisper-cli")
        if FileManager.default.isExecutableFile(atPath: whisper.path) { environment["WORKLOG_BUNDLED_WHISPER_CLI"] = whisper.path }
        environment["PATH"] = [resourceURL.appendingPathComponent("bin").path, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].joined(separator: ":")
        process.environment = environment
        let logDirectory = dataURL
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let logURL = logDirectory.appendingPathComponent("app-service.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        if let handle = try? FileHandle(forWritingTo: logURL) { handle.seekToEndOfFile(); process.standardOutput = handle; process.standardError = handle }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.serverReady = false; self?.updateStatus("后台服务已停止", healthy: false) } }
        do { try process.run(); service = process; launchingService = false }
        catch { launchingService = false; updateStatus("无法启动后台服务", healthy: false); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.refreshStatus(openSetupWhenReady: true) }
    }

    private func configureLoginItem() {
        if ProcessInfo.processInfo.environment["WORKLOG_DISABLE_LOGIN_ITEM"] == "1" { loginItemMenuItem.state = .off; return }
        if #available(macOS 13.0, *) {
            do { if SMAppService.mainApp.status == .notRegistered { try SMAppService.mainApp.register() } }
            catch { NSLog("Worklog login item: \(error)") }
            loginItemMenuItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
    }

    private func refreshStatus(openSetupWhenReady: Bool = false) {
        request(path: "/api/menu/status") { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let body):
                self.serverReady = true
                self.capturePaused = body["capturePaused"] as? Bool ?? false
                self.todayURL = body["todayUrl"] as? String ?? ""
                let setupReady = body["setupReady"] as? Bool ?? false
                self.updateStatus(self.capturePaused ? "采集已暂停" : setupReady ? "正在记录工作" : "等待完成首次设置", healthy: !self.capturePaused)
                self.pauseMenuItem.title = self.capturePaused ? "恢复采集" : "暂停采集"
                self.todayMenuItem.isEnabled = !self.todayURL.isEmpty
                if openSetupWhenReady && !setupReady { self.showWindow(path: "/setup.html", title: "开始使用 Worklog") }
            case .failure:
                self.serverReady = false
                self.updateStatus("后台服务未连接", healthy: false)
                if Date() >= self.nextRestartAt { self.launchBundledService() }
            }
        }
    }

    private func updateStatus(_ title: String, healthy: Bool) {
        DispatchQueue.main.async {
            self.statusMenuItem.title = title
            self.statusItem.button?.contentTintColor = healthy ? .systemGreen : .systemOrange
        }
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        var request = URLRequest(url: serverBase.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = path == "/api/run" ? 15 * 60 : 4
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("1", forHTTPHeaderField: "X-Worklog-Request") }
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { DispatchQueue.main.async { completion(.failure(error)) }; return }
            guard let http = response as? HTTPURLResponse, let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { completion(.failure(NSError(domain: "Worklog", code: 1))) }; return
            }
            guard (200..<300).contains(http.statusCode) else {
                let message = object["error"] as? String ?? "Worklog 请求失败（HTTP \(http.statusCode)）"
                DispatchQueue.main.async { completion(.failure(NSError(domain: "Worklog", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message]))) }; return
            }
            DispatchQueue.main.async { completion(.success(object)) }
        }.resume()
    }

    private func showWindow(path: String, title: String) {
        if let window { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 940, height: 760), configuration: configuration)
        webView.navigationDelegate = self; webView.uiDelegate = self
        let window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title; window.contentView = webView; window.center(); window.delegate = self
        self.window = window
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: serverBase.appendingPathComponent(path)))
    }

    func windowWillClose(_ notification: Notification) { window = nil }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost") { decisionHandler(.allow); return }
        if url.scheme == "https" || url.scheme == "http" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    @objc private func openDashboard() { showWindow(path: "/", title: "Worklog") }
    @objc private func openSetup() { showWindow(path: "/setup.html", title: "开始使用 Worklog") }
    @objc private func generateToday() { request(path: "/api/run", method: "POST", body: ["force": true]) { [weak self] result in self?.updateStatus(result.isSuccess ? "今天日报已生成" : "日报生成失败", healthy: result.isSuccess); self?.refreshStatus() } }
    @objc private func openToday() { if let url = URL(string: todayURL), !todayURL.isEmpty { NSWorkspace.shared.open(url) } }
    @objc private func toggleCapture() { request(path: "/api/capture", method: "POST", body: ["paused": !capturePaused]) { [weak self] _ in self?.refreshStatus() } }
    @objc private func toggleLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        do { if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() } }
        catch { updateStatus("无法更新登录启动设置", healthy: false) }
        loginItemMenuItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }
    @objc private func quit() {
        guard !serviceToken.isEmpty else { NSApp.terminate(nil); return }
        request(path: "/api/shutdown", method: "POST", body: ["token": serviceToken]) { _ in NSApp.terminate(nil) }
    }
}

private extension Result {
    var isSuccess: Bool { if case .success = self { return true }; return false }
}
