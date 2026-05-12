import CoreData
import Foundation

/// Mutating counterpart to `CoreDataInspector`. Used by the HTTP router only
/// when `Options.readOnly == false`. All work runs inside the inspector's
/// `perform` helper (i.e. on the context's serial queue).
final class CoreDataMutator {

    let inspector: CoreDataInspector

    init(inspector: CoreDataInspector) {
        self.inspector = inspector
    }

    /// Apply a partial attribute patch and save. Relationships are not touched —
    /// passing a relationship name in `attrs` is rejected.
    /// Returns the freshly-built detail DTO for the saved object.
    func update(contextName: String?, id idString: String, attrs: [String: Any]) throws -> RecordDetailDTO {
        try inspector.perform(contextName: contextName) { ctx in
            let obj = try CoreDataInspector.resolveObject(idString: idString, in: ctx)

            if !attrs.isEmpty {
                let attrMap = obj.entity.attributesByName
                let relSet = Set(obj.entity.relationshipsByName.keys)

                for (key, raw) in attrs {
                    if relSet.contains(key) {
                        throw InspectError.badParam("`\(key)` is a relationship and cannot be edited")
                    }
                    guard let attr = attrMap[key] else {
                        throw InspectError.badParam("Unknown attribute `\(key)` on \(obj.entity.name ?? "?")")
                    }
                    let decoded = try ValueDecoding.decode(raw, attribute: attr)
                    obj.setValue(decoded, forKey: key)
                }

                do {
                    try obj.validateForUpdate()
                } catch {
                    throw InspectError.badParam(error.localizedDescription)
                }

                do {
                    try ctx.save()
                } catch {
                    throw InspectError.fetch(error.localizedDescription)
                }
            }

            return CoreDataInspector.makeDetailDTO(for: obj)
        }
    }

    /// Delete the resolved object and save. Returns the id that was deleted.
    func delete(contextName: String?, id idString: String) throws -> String {
        try inspector.perform(contextName: contextName) { ctx in
            let obj = try CoreDataInspector.resolveObject(idString: idString, in: ctx)
            let uri = obj.objectID.uriRepresentation().absoluteString
            ctx.delete(obj)
            do {
                try ctx.save()
            } catch {
                throw InspectError.fetch(error.localizedDescription)
            }
            return uri
        }
    }
}
