import AppKit
import Foundation
import Darwin

enum FdmBridge {
    static let port: UInt16 = 47231
}

/// Speaks Chrome's native-messaging frames with Free Download Manager's wenativehost.
final class FdmHostBridge {
    static let shared = FdmHostBridge()

    private let hostPath = "/Applications/Free Download Manager.app/Contents/MacOS/wenativehost"
    private let hostOrigin = "chrome-extension://ahmpjcflkgiildlgicmcieglgoilbfdp/"
    private let queue = DispatchQueue(label: "com.macsword.fdmsafari.host")
    private var process: Process?
    private var stdinHandle: FileHandle?
    private var buffer = Data()
    private var waiters: [String: ([String: Any]) -> Void] = [:]

    func send(_ message: [String: Any]) -> [String: Any] {
        let requestId = stringId(message["id"]) ?? UUID().uuidString
        var outbound = message
        outbound["id"] = requestId

        let semaphore = DispatchSemaphore(value: 0)
        var response: [String: Any] = ["id": requestId, "error": "native host failed"]

        queue.async {
            do {
                try self.ensureStarted()
                guard let stdin = self.stdinHandle else {
                    throw BridgeError.hostMissing("The native host pipe is closed.")
                }
                let body = try JSONSerialization.data(withJSONObject: outbound, options: [.withoutEscapingSlashes])
                var length = UInt32(body.count).littleEndian
                var packet = Data(bytes: &length, count: 4)
                packet.append(body)
                self.waiters[requestId] = { reply in
                    response = reply
                    semaphore.signal()
                }
                try stdin.write(contentsOf: packet)
            } catch {
                self.waiters.removeValue(forKey: requestId)
                response = ["id": requestId, "error": error.localizedDescription]
                semaphore.signal()
            }
        }

        if semaphore.wait(timeout: .now() + 12) == .timedOut {
            queue.async { self.waiters.removeValue(forKey: requestId) }
            return ["id": requestId, "error": "Free Download Manager took too long to answer."]
        }
        return response
    }

    private func ensureStarted() throws {
        if let process = process, process.isRunning { return }
        stopLocked()

        guard FileManager.default.isExecutableFile(atPath: hostPath) else {
            throw BridgeError.hostMissing("Free Download Manager is not installed.")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: hostPath)
        process.arguments = [hostOrigin]
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { [weak self] _ in
            self?.queue.async { self?.failAll("Free Download Manager closed the connection.") }
        }
        try process.run()
        self.process = process
        stdinHandle = input.fileHandleForWriting
        buffer.removeAll(keepingCapacity: true)

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            self?.queue.async {
                if chunk.isEmpty {
                    self?.failAll("Free Download Manager closed the connection.")
                    return
                }
                self?.consume(chunk)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        while buffer.count >= 4 {
            let bytes = [UInt8](buffer.prefix(4))
            let length = Int(UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24))
            if length < 0 || length > 8_000_000 {
                failAll("Free Download Manager sent a message that could not be read.")
                stopLocked()
                return
            }
            if buffer.count < 4 + length { return }
            let body = buffer.subdata(in: 4..<(4 + length))
            buffer.removeSubrange(0..<(4 + length))
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                continue
            }
            guard let id = stringId(object["id"]), let waiter = waiters.removeValue(forKey: id) else {
                continue
            }
            waiter(object)
        }
    }

    private func failAll(_ message: String) {
        let pending = waiters
        waiters.removeAll()
        for (id, waiter) in pending {
            waiter(["id": id, "error": message])
        }
        stopLocked()
    }

    private func stopLocked() {
        stdinHandle = nil
        process?.terminationHandler = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil
        buffer.removeAll(keepingCapacity: false)
    }

    private func stringId(_ value: Any?) -> String? {
        switch value {
        case let text as String:
            return text
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }
}

private enum BridgeError: LocalizedError {
    case hostMissing(String)
    var errorDescription: String? {
        switch self {
        case .hostMissing(let message): return message
        }
    }
}

/// Localhost bridge so the sandboxed Safari extension can reach wenativehost.
final class BridgeServer {
    static let shared = BridgeServer()
    private var listenSocket: Int32 = -1

    func start() {
        DispatchQueue.global(qos: .userInitiated).async {
            self.acceptLoop()
        }
    }

    private func acceptLoop() {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout.size(ofValue: reuse)))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout.size(ofValue: addr))
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = FdmBridge.port.bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 {
            close(fd)
            if CommandLine.arguments.contains("--bridge") {
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            return
        }
        listen(fd, 16)
        listenSocket = fd
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            DispatchQueue.global(qos: .userInitiated).async {
                self.serve(client)
            }
        }
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        guard let header = SocketIO.readExact(client, 4) else { return }
        let bytes = [UInt8](header)
        let length = Int(UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24))
        guard length > 0, length < 8_000_000, let body = SocketIO.readExact(client, length) else { return }
        guard let message = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return }
        let response = FdmHostBridge.shared.send(message)
        guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.withoutEscapingSlashes]) else { return }
        var prefix = UInt32(data.count).littleEndian
        var packet = Data(bytes: &prefix, count: 4)
        packet.append(data)
        SocketIO.writeAll(client, packet)
    }
}

enum SocketIO {
    static func readExact(_ fd: Int32, _ count: Int) -> Data? {
        var data = Data(count: count)
        var got = 0
        while got < count {
            let n = data.withUnsafeMutableBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return Darwin.recv(fd, base.advanced(by: got), count - got, 0)
            }
            if n <= 0 { return nil }
            got += n
        }
        return data
    }

    static func writeAll(_ fd: Int32, _ data: Data) {
        var sent = 0
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            while sent < data.count {
                let n = Darwin.send(fd, base.advanced(by: sent), data.count - sent, 0)
                if n <= 0 { return }
                sent += n
            }
        }
    }
}
