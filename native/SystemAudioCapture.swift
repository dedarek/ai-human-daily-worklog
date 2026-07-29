import Foundation
import AVFoundation
import CoreGraphics
import CoreMedia
@preconcurrency import ScreenCaptureKit

@main
struct SystemAudioCapture {
    static func main() async {
        if CommandLine.arguments.contains("--permission-status") {
            let payload = ["screenCapture": CGPreflightScreenCaptureAccess()]
            let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            return
        }
        if CommandLine.arguments.contains("--request-permission") {
            let payload = ["screenCapture": CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()]
            let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            return
        }
        do {
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
                fputs("需要“屏幕与系统音频录制”权限，无法采集电脑声音。\n", stderr)
                exit(2)
            }

            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                fputs("没有找到可用于系统音频采集的显示器。\n", stderr)
                exit(3)
            }
            let teams = content.applications.filter { application in
                application.bundleIdentifier.localizedCaseInsensitiveContains("microsoft.teams")
            }
            guard !teams.isEmpty else {
                fputs("没有找到正在运行的 Microsoft Teams 音频进程。\n", stderr)
                exit(4)
            }
            // 仅包含 Teams 进程，避免把通知、音乐或其他应用的系统声音混入会议。
            let filter = SCContentFilter(display: display, including: teams, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            configuration.width = 2
            configuration.height = 2

            let output = PCMOutput()
            let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "worklog.system-audio"))
            try await stream.startCapture()

            // 原始 16 kHz / 单声道 / Int16 PCM 持续写到 stdout，由 Worklog 封装成 WAV。
            while true {
                try await Task.sleep(for: .seconds(60))
            }
        } catch {
            fputs("系统音频采集失败：\(error)\n", stderr)
            exit(1)
        }
    }
}

final class PCMOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        do {
            try sampleBuffer.withAudioBufferList { audioBufferList, _ in
                guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription else { return }
                guard let sourceFormat = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32,
                    sampleRate: description.mSampleRate,
                    channels: description.mChannelsPerFrame,
                    interleaved: false
                ) else { return }

                if converter == nil {
                    guard let target = AVAudioFormat(
                        commonFormat: .pcmFormatInt16,
                        sampleRate: 16_000,
                        channels: 1,
                        interleaved: true
                    ) else { return }
                    converter = AVAudioConverter(from: sourceFormat, to: target)
                    targetFormat = target
                }
                guard let converter, let targetFormat else { return }

                let inputFrames = AVAudioFrameCount(sampleBuffer.numSamples)
                guard let input = AVAudioPCMBuffer(pcmFormat: converter.inputFormat, frameCapacity: inputFrames) else { return }
                input.frameLength = inputFrames
                let channelCount = min(Int(converter.inputFormat.channelCount), audioBufferList.count)
                for channel in 0..<channelCount {
                    guard let destination = input.floatChannelData?[channel],
                          let source = audioBufferList[channel].mData else { continue }
                    let byteCount = min(
                        Int(audioBufferList[channel].mDataByteSize),
                        Int(inputFrames) * MemoryLayout<Float>.size
                    )
                    memcpy(destination, source, byteCount)
                }

                let capacity = AVAudioFrameCount(ceil(Double(inputFrames) * targetFormat.sampleRate / converter.inputFormat.sampleRate)) + 1
                guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
                var supplied = false
                var conversionError: NSError?
                let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                    if supplied {
                        inputStatus.pointee = .noDataNow
                        return nil
                    }
                    supplied = true
                    inputStatus.pointee = .haveData
                    return input
                }
                guard status != .error, output.frameLength > 0, let samples = output.int16ChannelData?[0] else {
                    if let conversionError { fputs("音频转换失败：\(conversionError)\n", stderr) }
                    return
                }
                FileHandle.standardOutput.write(Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Int16>.size))
            }
        } catch {
            fputs("系统音频处理失败：\(error)\n", stderr)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("系统音频流已停止：\(error)\n", stderr)
        exit(1)
    }
}
