import Foundation

struct EntityDTO: Encodable {
    let name: String
    let count: Int
    let attributes: [AttributeDTO]
    let relationships: [RelationshipDTO]
}

struct AttributeDTO: Encodable {
    let name: String
    let type: String
    let optional: Bool
    let searchable: Bool
}

struct RelationshipDTO: Encodable {
    let name: String
    let destination: String?
    let toMany: Bool
}

struct RecordsPageDTO: Encodable {
    let entity: String
    let total: Int
    let offset: Int
    let limit: Int
    let rows: [RecordRowDTO]
}

struct RecordRowDTO: Encodable {
    let id: String
    let summary: String
    let attrs: [String: JSONValue]
}

struct RecordDetailDTO: Encodable {
    let id: String
    let entity: String
    let attrs: [String: JSONValue]
    let relationships: [RelationshipValueDTO]
}

struct RelationshipValueDTO: Encodable {
    let name: String
    let destination: String?
    let toMany: Bool
    let count: Int?
    let items: [RecordSummaryDTO]
    let truncated: Bool
}

struct RecordSummaryDTO: Encodable {
    let id: String
    let entity: String
    let summary: String
}

struct HealthDTO: Encodable {
    let ok: Bool
    let store: String?
    let readOnly: Bool
    let capabilities: [String]
}

struct ContextDTO: Encodable {
    let name: String
    let store: String?
    let isDefault: Bool
}

struct DeletedDTO: Encodable {
    let ok: Bool
    let id: String
}

enum JSONValue: Encodable {
    case string(String)
    case int(Int64)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case null

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}
