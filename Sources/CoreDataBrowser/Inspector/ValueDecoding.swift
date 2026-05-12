import CoreData
import Foundation

/// Inverse of `ValueEncoding`. Coerces a JSON value (as produced by
/// `JSONSerialization`) into a typed value suitable for assignment to a
/// Core Data attribute. Throws `InspectError.badParam` with a per-attribute
/// message when the value is missing, the wrong shape, or out of range.
enum ValueDecoding {

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Decode a JSON value into the type expected by `attribute`. `NSNull` and
    /// `nil` both mean "set to null" — rejected if the attribute is non-optional.
    static func decode(_ raw: Any?, attribute attr: NSAttributeDescription) throws -> Any? {
        let attrName = attr.name

        if raw == nil || raw is NSNull {
            if !attr.isOptional {
                throw InspectError.badParam("`\(attrName)` is not optional and cannot be null")
            }
            return nil
        }
        let value = raw!

        switch attr.attributeType {
        case .stringAttributeType:
            guard let s = value as? String else { throw mismatch(attrName, "String") }
            return s

        case .booleanAttributeType:
            if let b = value as? Bool { return NSNumber(value: b) }
            if let n = value as? NSNumber { return NSNumber(value: n.boolValue) }
            if let s = value as? String {
                if s == "true" { return NSNumber(value: true) }
                if s == "false" { return NSNumber(value: false) }
            }
            throw mismatch(attrName, "Bool")

        case .integer16AttributeType:
            let n = try numberValue(value, attrName, "Int16")
            let v = n.int64Value
            guard v >= Int64(Int16.min) && v <= Int64(Int16.max) else {
                throw InspectError.badParam("`\(attrName)` value \(v) out of range for Int16")
            }
            return NSNumber(value: Int16(v))

        case .integer32AttributeType:
            let n = try numberValue(value, attrName, "Int32")
            let v = n.int64Value
            guard v >= Int64(Int32.min) && v <= Int64(Int32.max) else {
                throw InspectError.badParam("`\(attrName)` value \(v) out of range for Int32")
            }
            return NSNumber(value: Int32(v))

        case .integer64AttributeType:
            let n = try numberValue(value, attrName, "Int64")
            return NSNumber(value: n.int64Value)

        case .floatAttributeType:
            let n = try numberValue(value, attrName, "Float")
            return NSNumber(value: n.floatValue)

        case .doubleAttributeType:
            let n = try numberValue(value, attrName, "Double")
            return NSNumber(value: n.doubleValue)

        case .decimalAttributeType:
            if let s = value as? String {
                let d = NSDecimalNumber(string: s)
                if d == NSDecimalNumber.notANumber {
                    throw InspectError.badParam("`\(attrName)` is not a valid Decimal: \(s)")
                }
                return d
            }
            if let n = value as? NSNumber {
                return NSDecimalNumber(decimal: n.decimalValue)
            }
            throw mismatch(attrName, "Decimal (string or number)")

        case .dateAttributeType:
            guard let s = value as? String else { throw mismatch(attrName, "Date (ISO 8601 string)") }
            if let d = isoFractional.date(from: s) { return d }
            if let d = isoPlain.date(from: s) { return d }
            throw InspectError.badParam("`\(attrName)` is not a valid ISO 8601 date: \(s)")

        case .UUIDAttributeType:
            guard let s = value as? String, let id = UUID(uuidString: s) else {
                throw mismatch(attrName, "UUID")
            }
            return id

        case .URIAttributeType:
            guard let s = value as? String, let url = URL(string: s) else {
                throw mismatch(attrName, "URI")
            }
            return url

        case .binaryDataAttributeType:
            guard let s = value as? String else {
                throw mismatch(attrName, "Binary (base64 string)")
            }
            guard let data = Data(base64Encoded: s, options: [.ignoreUnknownCharacters]) else {
                throw InspectError.badParam("`\(attrName)` is not valid base64")
            }
            let cap = 10 * 1024 * 1024
            if data.count > cap {
                throw InspectError.badParam("`\(attrName)` exceeds 10 MB limit (\(data.count) bytes)")
            }
            return data

        case .transformableAttributeType:
            throw InspectError.badParam("`\(attrName)`: editing Transformable attributes is not supported")

        case .objectIDAttributeType:
            throw InspectError.badParam("`\(attrName)`: object-id attributes cannot be edited")

        default:
            throw InspectError.badParam("`\(attrName)`: unsupported attribute type")
        }
    }

    private static func numberValue(_ value: Any, _ name: String, _ expected: String) throws -> NSNumber {
        if let n = value as? NSNumber { return n }
        if let s = value as? String, let d = Double(s) { return NSNumber(value: d) }
        throw mismatch(name, expected)
    }

    private static func mismatch(_ name: String, _ expected: String) -> InspectError {
        .badParam("`\(name)` expected \(expected)")
    }
}
