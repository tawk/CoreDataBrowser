import CoreData
import Foundation
import Swifter

public final class CoreDataBrowserServer: @unchecked Sendable {

    public struct Options: Sendable {
        /// Preferred port. If busy, the server tries `port + 1` up to `port + 10`.
        public var port: UInt16 = 8080

        /// Bind address. `.allInterfaces` exposes the server to the local network.
        /// `.loopback` restricts it to the device itself (use with port forwarding).
        public var bindAddress: BindAddress = .allInterfaces

        /// Reserved for v2 (CRUD). Currently always read-only.
        public var readOnly: Bool = true

        public init() {}
    }

    public enum BindAddress: Sendable {
        case loopback
        case allInterfaces
    }

    public struct RunningInfo: Sendable {
        public let port: UInt16
        /// Every URL the server can be reached at.
        public let urls: [URL]
    }

    /// A named managed object context the browser will expose. When the server
    /// is constructed with more than one, the web UI shows a context switcher
    /// in its top bar and tags every API request with `?ctx=<name>`.
    public struct Context {
        public let name: String
        public let context: NSManagedObjectContext
        public init(name: String, context: NSManagedObjectContext) {
            self.name = name
            self.context = context
        }
    }

    public enum StartError: Error, LocalizedError {
        case allPortsBusy(tried: ClosedRange<UInt16>)
        case underlying(Error)

        public var errorDescription: String? {
            switch self {
            case .allPortsBusy(let r): return "No port in \(r.lowerBound)…\(r.upperBound) could be bound."
            case .underlying(let e): return e.localizedDescription
            }
        }
    }

    private let inspector: CoreDataInspector
    private let options: Options
    private let queue = DispatchQueue(label: "to.tawk.CoreDataBrowser.server")
    private var router: HTTPRouter?
    private var info: RunningInfo?

    /// Convenience initializer for a single context. The context is exposed
    /// under the name `context.name` if set, otherwise `"default"`.
    public convenience init(context: NSManagedObjectContext, options: Options = .init()) {
        let name = (context.name?.isEmpty == false ? context.name : nil) ?? "default"
        self.init(contexts: [Context(name: name, context: context)], options: options)
    }

    /// Browse multiple named contexts in one server. The web UI shows a
    /// switcher in the top bar; clients tag requests with `?ctx=<name>`.
    /// Duplicate names are dropped (first wins).
    public init(contexts: [Context], options: Options = .init()) {
        precondition(!contexts.isEmpty, "CoreDataBrowserServer needs at least one context")
        let entries = contexts.map { CoreDataInspector.Entry(name: $0.name, context: $0.context) }
        self.inspector = CoreDataInspector(entries: entries)
        self.options = options
    }

    public var isRunning: Bool {
        queue.sync { router != nil }
    }

    public var runningInfo: RunningInfo? {
        queue.sync { info }
    }

    @discardableResult
    public func start() throws -> RunningInfo {
        try queue.sync {
            if let existing = info { return existing }

            let router = HTTPRouter(inspector: inspector, readOnly: options.readOnly)
            if options.bindAddress == .loopback {
                router.server.listenAddressIPv4 = "127.0.0.1"
            }

            let basePort = options.port
            let maxOffset: UInt16 = 10
            var lastError: Error?
            for offset in 0...maxOffset {
                let candidate = basePort &+ offset
                do {
                    try router.server.start(in_port_t(candidate), forceIPv4: true)
                    let addresses: [String] = {
                        if options.bindAddress == .loopback { return ["127.0.0.1"] }
                        return NetworkInterfaces.ipv4Addresses()
                    }()
                    let urls = addresses.compactMap { URL(string: "http://\($0):\(candidate)") }
                    let runningInfo = RunningInfo(port: candidate, urls: urls)
                    self.router = router
                    self.info = runningInfo
                    return runningInfo
                } catch {
                    lastError = error
                    continue
                }
            }
            if let lastError {
                throw StartError.underlying(lastError)
            }
            throw StartError.allPortsBusy(tried: basePort...(basePort &+ maxOffset))
        }
    }

    public func stop() {
        queue.sync {
            router?.server.stop()
            router = nil
            info = nil
        }
    }
}
