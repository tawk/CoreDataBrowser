import Foundation
import Swifter

enum JSONResponse {

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static let commonHeaders: [String: String] = [
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
    ]

    static func ok<T: Encodable>(_ value: T, extraHeaders: [String: String] = [:]) -> HttpResponse {
        encoded(status: 200, value: value, extraHeaders: extraHeaders)
    }

    static func error(_ status: Int, _ message: String) -> HttpResponse {
        let body: [String: String] = ["error": message]
        return encoded(status: status, value: body, extraHeaders: [:])
    }

    private static func encoded<T: Encodable>(status: Int, value: T, extraHeaders: [String: String]) -> HttpResponse {
        let data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            return raw(500, body: Data(#"{"error":"encode failed"}"#.utf8), headers: commonHeaders)
        }
        var headers = commonHeaders
        for (k, v) in extraHeaders { headers[k] = v }
        return raw(status, body: data, headers: headers)
    }

    static func raw(_ status: Int, body: Data, headers: [String: String]) -> HttpResponse {
        .raw(status, statusText(for: status), headers) { writer in
            try writer.write(body)
        }
    }

    static func file(_ data: Data, contentType: String) -> HttpResponse {
        let headers: [String: String] = [
            "Content-Type": contentType,
            "Cache-Control": "no-cache"
        ]
        return raw(200, body: data, headers: headers)
    }

    private static func statusText(for code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}
