import Foundation
import CoreAudio

struct AudioStatus: Codable {
    let teamsAudioInstalled: Bool
    let teamsAudioRunning: Bool
    let teamsAudioDevice: String?
    let defaultInputDevice: String?
}

func readString(_ object: AudioObjectID, selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let result = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    return result == noErr ? value as String? : nil
}

func defaultInputName() -> String? {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return nil }
    return readString(device, selector: kAudioObjectPropertyName)
}

var devicesAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var devicesSize: UInt32 = 0
guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &devicesSize) == noErr else { exit(2) }
var devices = [AudioObjectID](repeating: 0, count: Int(devicesSize) / MemoryLayout<AudioObjectID>.size)
guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &devicesSize, &devices) == noErr else { exit(2) }

var teamsName: String? = nil
var teamsRunning = false
for device in devices {
    guard let name = readString(device, selector: kAudioObjectPropertyName), name.localizedCaseInsensitiveContains("Microsoft Teams Audio") else { continue }
    teamsName = name
    var runAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var running: UInt32 = 0
    var runSize = UInt32(MemoryLayout<UInt32>.size)
    if AudioObjectGetPropertyData(device, &runAddress, 0, nil, &runSize, &running) == noErr { teamsRunning = running != 0 }
}

let output = AudioStatus(teamsAudioInstalled: teamsName != nil, teamsAudioRunning: teamsRunning, teamsAudioDevice: teamsName, defaultInputDevice: defaultInputName())
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(output))
