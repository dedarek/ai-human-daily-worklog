import ApplicationServices
import AppKit
import Foundation

if CommandLine.arguments.contains("--frontmost") {
    let application = NSWorkspace.shared.frontmostApplication
    var title = ""
    if let processIdentifier = application?.processIdentifier {
        let app = AXUIElementCreateApplication(processIdentifier)
        var window: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
           let window {
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &value) == .success {
                title = value as? String ?? ""
            }
        }
    }
    let payload = ["app": application?.localizedName ?? "", "windowTitle": title]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    exit(0)
}

let request = CommandLine.arguments.contains("--request-accessibility")
let trusted: Bool
if request {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    trusted = AXIsProcessTrustedWithOptions(options)
} else {
    trusted = AXIsProcessTrusted()
}

let payload = ["accessibility": trusted]
let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
