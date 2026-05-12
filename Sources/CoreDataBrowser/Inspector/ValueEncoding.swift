import CoreData
import Foundation

enum ValueEncoding {

    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func encode(_ value: Any?, attribute: NSAttributeDescription) -> JSONValue {
        guard let value, !(value is NSNull) else { return .null }

        switch attribute.attributeType {
        case .stringAttributeType:
            return .string(value as? String ?? String(describing: value))
        case .booleanAttributeType:
            if let n = value as? NSNumber { return .bool(n.boolValue) }
            return .bool((value as? Bool) ?? false)
        case .integer16AttributeType, .integer32AttributeType, .integer64AttributeType:
            if let n = value as? NSNumber { return .int(n.int64Value) }
            return .null
        case .doubleAttributeType, .floatAttributeType:
            if let n = value as? NSNumber { return .double(n.doubleValue) }
            return .null
        case .decimalAttributeType:
            if let d = value as? NSDecimalNumber { return .string(d.stringValue) }
            if let d = value as? Decimal { return .string(NSDecimalNumber(decimal: d).stringValue) }
            return .null
        case .dateAttributeType:
            if let date = value as? Date { return .string(iso8601.string(from: date)) }
            return .null
        case .UUIDAttributeType:
            if let id = value as? UUID { return .string(id.uuidString) }
            return .null
        case .URIAttributeType:
            if let url = value as? URL { return .string(url.absoluteString) }
            return .null
        case .binaryDataAttributeType:
            if let data = value as? Data {
                return .object([
                    "type": .string("binary"),
                    "bytes": .int(Int64(data.count))
                ])
            }
            return .null
        case .transformableAttributeType:
            return .object([
                "type": .string("transformable"),
                "description": .string(String(describing: value).truncatedDescription())
            ])
        case .objectIDAttributeType:
            if let oid = value as? NSManagedObjectID {
                return .string(oid.uriRepresentation().absoluteString)
            }
            return .null
        default:
            return .string(String(describing: value).truncatedDescription())
        }
    }

    static func attributeTypeName(_ type: NSAttributeType) -> String {
        switch type {
        case .stringAttributeType: return "String"
        case .booleanAttributeType: return "Bool"
        case .integer16AttributeType: return "Int16"
        case .integer32AttributeType: return "Int32"
        case .integer64AttributeType: return "Int64"
        case .doubleAttributeType: return "Double"
        case .floatAttributeType: return "Float"
        case .decimalAttributeType: return "Decimal"
        case .dateAttributeType: return "Date"
        case .UUIDAttributeType: return "UUID"
        case .URIAttributeType: return "URI"
        case .binaryDataAttributeType: return "Binary"
        case .transformableAttributeType: return "Transformable"
        case .objectIDAttributeType: return "ObjectID"
        case .undefinedAttributeType: return "Undefined"
        default: return "Other(\(type.rawValue))"
        }
    }
}

private extension String {
    func truncatedDescription(limit: Int = 200) -> String {
        count > limit ? String(prefix(limit)) + "…" : self
    }
}
