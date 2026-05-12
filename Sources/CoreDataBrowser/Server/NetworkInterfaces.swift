import Foundation
#if canImport(Darwin)
import Darwin
#endif

enum NetworkInterfaces {

    /// Returns a sorted, de-duplicated list of IPv4 strings the server is reachable at,
    /// including `127.0.0.1` and any non-loopback Wi-Fi/Ethernet interface.
    static func ipv4Addresses() -> [String] {
        var result = Set<String>(["127.0.0.1"])

        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else {
            return Array(result).sorted()
        }
        defer { freeifaddrs(ifaddrPtr) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let ptr = cursor {
            let ifa = ptr.pointee
            if let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) {
                let flags = Int32(ifa.ifa_flags)
                let isUp = (flags & IFF_UP) == IFF_UP
                let isLoopback = (flags & IFF_LOOPBACK) == IFF_LOOPBACK
                if isUp, !isLoopback {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    let res = getnameinfo(
                        addr,
                        socklen_t(addr.pointee.sa_len),
                        &hostname,
                        socklen_t(hostname.count),
                        nil,
                        0,
                        NI_NUMERICHOST
                    )
                    if res == 0 {
                        let s = String(cString: hostname)
                        // Filter link-local / unhelpful addresses
                        if !s.hasPrefix("169.254.") {
                            result.insert(s)
                        }
                    }
                }
            }
            cursor = ifa.ifa_next
        }

        // Sort so loopback comes last, real LAN addresses first
        return Array(result).sorted { a, b in
            let la = a == "127.0.0.1"
            let lb = b == "127.0.0.1"
            if la != lb { return !la }
            return a < b
        }
    }
}
