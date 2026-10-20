import AppKit
import Foundation
import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let port: UInt16 = 47231

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let raw = item?.userInfo?[SFExtensionMessageKey]
        let message = dictionary(from: raw)

        guard let message = message else {
            finish(context, ["error": "The extension sent a message that could not be read."])
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let response = self.transact(message)
            DispatchQueue.main.async {
                self.finish(context, response)
            }
        }
    }

    private func transact(_ message: [String: Any]) -> [String: Any] {
        if let response = exchange(message) { return response }
        launchContainerApp()
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            if let response = exchange(message) { return response }
        }
        return ["error": "Open the FDM for Safari app and leave it running."]
    }

    private func exchange(_ message: [String: Any]) -> [String: Any]? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { close(fd) }
        var timeout = timeval(tv_sec: 12, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout.size(ofValue: addr))
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr)
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if connected != 0 { return nil }

        guard let body = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]) else {
            return ["error": "Could not encode the message for Free Download Manager."]
        }
        var length = UInt32(body.count).littleEndian
        var packet = Data(bytes: &length, count: 4)
        packet.append(body)
        writeAll(fd, packet)
        guard let header = readExact(fd, 4) else { return nil }
        let bytes = [UInt8](header)
        let size = Int(UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24))
        guard size > 0, size < 8_000_000, let reply = readExact(fd, size) else { return nil }
        return try? JSONSerialization.jsonObject(with: reply) as? [String: Any]
    }

    private func launchContainerApp() {
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        guard appURL.pathExtension == "app" else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.arguments = ["--bridge"]
        let semaphore = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { _, _ in
            semaphore.signal()
        }
        semaphore.wait(timeout: .now() + 3)
    }

    private func finish(_ context: NSExtensionContext, _ response: [String: Any]) {
        let item = NSExtensionItem()
        item.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    private func dictionary(from raw: Any?) -> [String: Any]? {
        if let message = raw as? [String: Any] { return message }
        guard let raw = raw as? [AnyHashable: Any] else { return nil }
        var result: [String: Any] = [:]
        for (key, value) in raw {
            result[String(describing: key)] = value
        }
        return result
    }

    private func readExact(_ fd: Int32, _ count: Int) -> Data? {
        var data = Data(count: count)
        var got = 0
        while got < count {
            let n = data.withUnsafeMutableBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return recv(fd, base.advanced(by: got), count - got, 0)
            }
            if n <= 0 { return nil }
            got += n
        }
        return data
    }

    private func writeAll(_ fd: Int32, _ data: Data) {
        var sent = 0
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            while sent < data.count {
                let n = send(fd, base.advanced(by: sent), data.count - sent, 0)
                if n <= 0 { return }
                sent += n
            }
        }
    }
}
