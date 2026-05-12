import CoreData
import Foundation

enum InspectError: Error, LocalizedError {
    case unknownEntity(String)
    case unknownContext(String)
    case badParam(String)
    case notFound
    case fetch(String)

    var errorDescription: String? {
        switch self {
        case .unknownEntity(let n): return "Unknown entity: \(n)"
        case .unknownContext(let n): return "Unknown context: \(n)"
        case .badParam(let m): return m
        case .notFound: return "Not found"
        case .fetch(let m): return m
        }
    }

    var statusCode: Int {
        switch self {
        case .unknownEntity, .unknownContext, .notFound: return 404
        case .badParam: return 400
        case .fetch: return 500
        }
    }
}

enum SortOrder: String {
    case asc, desc
}

final class CoreDataInspector {

    struct Entry {
        let name: String
        let context: NSManagedObjectContext
    }

    let entries: [Entry]

    init(entries: [Entry]) {
        precondition(!entries.isEmpty, "CoreDataInspector requires at least one context")
        // De-duplicate by name; first occurrence wins.
        var seen = Set<String>()
        self.entries = entries.filter { e in seen.insert(e.name).inserted }
    }

    /// Resolve a context by name. Falls back to the first registered context.
    func resolve(_ name: String?) throws -> Entry {
        if let name, !name.isEmpty {
            guard let entry = entries.first(where: { $0.name == name }) else {
                throw InspectError.unknownContext(name)
            }
            return entry
        }
        return entries[0]
    }

    func perform<T>(contextName: String?, _ work: @escaping (NSManagedObjectContext) throws -> T) throws -> T {
        let entry = try resolve(contextName)
        var result: Result<T, Error>!
        let sem = DispatchSemaphore(value: 0)
        entry.context.perform {
            result = Result { try work(entry.context) }
            sem.signal()
        }
        sem.wait()
        return try result.get()
    }

    var defaultStoreDescription: String? {
        entries[0].context.persistentStoreCoordinator?.persistentStores.first?.url?.absoluteString
    }

    var contexts: [ContextDTO] {
        entries.enumerated().map { idx, e in
            ContextDTO(
                name: e.name,
                store: e.context.persistentStoreCoordinator?.persistentStores.first?.url?.absoluteString,
                isDefault: idx == 0
            )
        }
    }

    // MARK: - Entities

    func entities(contextName: String?) throws -> [EntityDTO] {
        try perform(contextName: contextName) { ctx in
            guard let coord = ctx.persistentStoreCoordinator else { return [] }
            let model = coord.managedObjectModel
            return try model.entities
                .filter { !$0.isAbstract }
                .compactMap { $0.name }
                .sorted()
                .map { try Self.makeEntityDTO(named: $0, in: ctx) }
        }
    }

    private static func makeEntityDTO(named name: String, in ctx: NSManagedObjectContext) throws -> EntityDTO {
        guard let entity = ctx.persistentStoreCoordinator?.managedObjectModel.entitiesByName[name] else {
            throw InspectError.unknownEntity(name)
        }

        let req = NSFetchRequest<NSNumber>(entityName: name)
        req.resultType = .countResultType
        let count = (try? ctx.count(for: req)) ?? 0

        let attrs = entity.attributesByName.values.sorted { $0.name < $1.name }.map { a in
            AttributeDTO(
                name: a.name,
                type: ValueEncoding.attributeTypeName(a.attributeType),
                optional: a.isOptional,
                searchable: a.attributeType == .stringAttributeType
            )
        }

        let rels = entity.relationshipsByName.values.sorted { $0.name < $1.name }.map { r in
            RelationshipDTO(
                name: r.name,
                destination: r.destinationEntity?.name,
                toMany: r.isToMany
            )
        }

        return EntityDTO(name: name, count: count, attributes: attrs, relationships: rels)
    }

    // MARK: - Records list

    func records(
        contextName: String?,
        entityName: String,
        search: String?,
        searchAttr: String?,
        sort: String?,
        order: SortOrder,
        limit: Int,
        offset: Int
    ) throws -> RecordsPageDTO {
        try perform(contextName: contextName) { ctx in
            guard let entity = ctx.persistentStoreCoordinator?.managedObjectModel.entitiesByName[entityName] else {
                throw InspectError.unknownEntity(entityName)
            }

            let req = NSFetchRequest<NSManagedObject>(entityName: entityName)
            req.fetchLimit = max(1, min(limit, 500))
            req.fetchOffset = max(0, offset)

            // Predicate
            if let term = search, !term.isEmpty {
                guard let attrName = searchAttr,
                      let attrDesc = entity.attributesByName[attrName],
                      attrDesc.attributeType == .stringAttributeType else {
                    throw InspectError.badParam("search requires `searchAttr` to be a string attribute on \(entityName)")
                }
                req.predicate = NSPredicate(format: "%K CONTAINS[cd] %@", attrName, term)
            }

            // Sort
            if let sortName = sort, !sortName.isEmpty {
                guard entity.attributesByName[sortName] != nil else {
                    throw InspectError.badParam("Unknown sort attribute \(sortName) on \(entityName)")
                }
                req.sortDescriptors = [NSSortDescriptor(key: sortName, ascending: order == .asc)]
            } else {
                req.sortDescriptors = []
            }

            // Total
            let countReq = NSFetchRequest<NSNumber>(entityName: entityName)
            countReq.predicate = req.predicate
            countReq.resultType = .countResultType
            let total: Int
            do {
                total = try ctx.count(for: countReq)
            } catch {
                throw InspectError.fetch(error.localizedDescription)
            }

            // Fetch
            let objects: [NSManagedObject]
            do {
                objects = try ctx.fetch(req)
            } catch {
                throw InspectError.fetch(error.localizedDescription)
            }

            let rows = objects.map { obj in
                RecordRowDTO(
                    id: obj.objectID.uriRepresentation().absoluteString,
                    summary: Self.summary(for: obj),
                    attrs: Self.encodedAttrs(of: obj)
                )
            }

            return RecordsPageDTO(
                entity: entityName,
                total: total,
                offset: req.fetchOffset,
                limit: req.fetchLimit,
                rows: rows
            )
        }
    }

    // MARK: - Record detail

    func detail(contextName: String?, id idString: String) throws -> RecordDetailDTO {
        try perform(contextName: contextName) { ctx in
            let obj = try Self.resolveObject(idString: idString, in: ctx)

            let relationships: [RelationshipValueDTO] = obj.entity.relationshipsByName.values
                .sorted { $0.name < $1.name }
                .map { rel in
                    let raw = obj.value(forKey: rel.name)
                    if rel.isToMany {
                        let items: [NSManagedObject]
                        if let s = raw as? Set<NSManagedObject> {
                            items = Array(s)
                        } else if let s = (raw as? NSOrderedSet)?.array as? [NSManagedObject] {
                            items = s
                        } else if let s = raw as? [NSManagedObject] {
                            items = s
                        } else {
                            items = []
                        }
                        let sorted = items.sorted { Self.summary(for: $0) < Self.summary(for: $1) }
                        let visible = Array(sorted.prefix(20))
                        return RelationshipValueDTO(
                            name: rel.name,
                            destination: rel.destinationEntity?.name,
                            toMany: true,
                            count: sorted.count,
                            items: visible.map(Self.summaryDTO(for:)),
                            truncated: sorted.count > visible.count
                        )
                    } else {
                        if let related = raw as? NSManagedObject {
                            return RelationshipValueDTO(
                                name: rel.name,
                                destination: rel.destinationEntity?.name,
                                toMany: false,
                                count: nil,
                                items: [Self.summaryDTO(for: related)],
                                truncated: false
                            )
                        }
                        return RelationshipValueDTO(
                            name: rel.name,
                            destination: rel.destinationEntity?.name,
                            toMany: false,
                            count: nil,
                            items: [],
                            truncated: false
                        )
                    }
                }

            return RecordDetailDTO(
                id: obj.objectID.uriRepresentation().absoluteString,
                entity: obj.entity.name ?? "?",
                attrs: Self.encodedAttrs(of: obj),
                relationships: relationships
            )
        }
    }

    // MARK: - Helpers

    private static func resolveObject(idString: String, in ctx: NSManagedObjectContext) throws -> NSManagedObject {
        guard let uri = URL(string: idString),
              let coord = ctx.persistentStoreCoordinator,
              let oid = coord.managedObjectID(forURIRepresentation: uri) else {
            throw InspectError.badParam("Invalid object id: \(idString)")
        }
        do {
            return try ctx.existingObject(with: oid)
        } catch {
            throw InspectError.notFound
        }
    }

    static func encodedAttrs(of obj: NSManagedObject) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (name, attr) in obj.entity.attributesByName {
            let v = obj.value(forKey: name)
            out[name] = ValueEncoding.encode(v, attribute: attr)
        }
        return out
    }

    static func summary(for obj: NSManagedObject) -> String {
        let attrs = obj.entity.attributesByName.values
            .filter { $0.attributeType == .stringAttributeType }
            .sorted { $0.name < $1.name }
        for a in attrs {
            if let s = obj.value(forKey: a.name) as? String, !s.isEmpty {
                return s
            }
        }
        let entityName = obj.entity.name ?? "?"
        let short = obj.objectID.uriRepresentation().lastPathComponent
        return "\(entityName) \(short)"
    }

    static func summaryDTO(for obj: NSManagedObject) -> RecordSummaryDTO {
        RecordSummaryDTO(
            id: obj.objectID.uriRepresentation().absoluteString,
            entity: obj.entity.name ?? "?",
            summary: summary(for: obj)
        )
    }
}
