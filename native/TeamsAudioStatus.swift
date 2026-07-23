import Foundation
import CoreAudio

struct AudioStatus: Codable {
    let teamsProcessAudioRunning: Bool
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

func readUInt32(_ object: AudioObjectID, selector: AudioObjectPropertySelector) -> UInt32 {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : 0
}

var teamsProcessAudioRunning = false
var processAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var processSize: UInt32 = 0
if AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &processAddress, 0, nil, &processSize) == noErr {
    var processes = [AudioObjectID](repeating: 0, count: Int(processSize) / MemoryLayout<AudioObjectID>.size)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &processAddress, 0, nil, &processSize, &processes) == noErr {
        for process in processes {
            guard let bundleID = readString(process, selector: kAudioProcessPropertyBundleID),
                  bundleID.localizedCaseInsensitiveContains("microsoft.teams") else { continue }
            if readUInt32(process, selector: kAudioProcessPropertyIsRunningInput) != 0 ||
                readUInt32(process, selector: kAudioProcessPropertyIsRunningOutput) != 0 {
                teamsProcessAudioRunning = true
            }
        }
    }
}

let output = AudioStatus(teamsProcessAudioRunning: teamsProcessAudioRunning)
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
FileHandle.standardOutput.write(try encoder.encode(output))
