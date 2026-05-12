import Foundation
import Swifter

final class HTTPRouter {

    let server = HttpServer()
    let inspector: CoreDataInspector
    let readOnly: Bool

    init(inspector: CoreDataInspector, readOnly: Bool) {
        self.inspector = inspector
        self.readOnly = readOnly
        wire()
    }

    private func wire() {
        // Static assets — single SPA, served at `/` (legacy `/lab` aliased to it)
        let labHTML: (HttpRequest) -> HttpResponse = { [weak self] _ in
            self?.serveResource("lab", ext: "html", contentType: "text/html; charset=utf-8") ?? .notFound
        }
        server.GET["/"] = labHTML
        server.GET["/index.html"] = labHTML
        server.GET["/lab"] = labHTML
        server.GET["/lab.html"] = labHTML
        server.GET["/lab.css"] = { [weak self] _ in self?.serveResource("lab", ext: "css", contentType: "text/css; charset=utf-8") ?? .notFound }
        server.GET["/lab.js"] = { [weak self] _ in self?.serveResource("lab", ext: "js", contentType: "application/javascript; charset=utf-8") ?? .notFound }

        // API
        server.GET["/api/health"] = { [weak self] _ in self?.health() ?? .internalServerError }
        server.GET["/api/contexts"] = { [weak self] _ in self?.contexts() ?? .internalServerError }
        server.GET["/api/entities"] = { [weak self] req in self?.allEntities(req) ?? .internalServerError }
        server.GET["/api/entities/:name"] = { [weak self] req in self?.records(req) ?? .internalServerError }
        server.GET["/api/object"] = { [weak self] req in self?.detail(req, export: false) ?? .internalServerError }
        server.GET["/api/object/export"] = { [weak self] req in self?.detail(req, export: true) ?? .internalServerError }

        // Write methods — explicit 405 for clarity while read-only.
        let blocked: (HttpRequest) -> HttpResponse = { [weak self] _ in
            if self?.readOnly == false { return .notFound }
            return JSONResponse.error(405, "read-only")
        }
        server.POST["/api/object"] = blocked
        server.PATCH["/api/object"] = blocked
        server.PUT["/api/object"] = blocked
        server.DELETE["/api/object"] = blocked
    }

    // MARK: - Resources

    private func serveResource(_ name: String, ext: String, contentType: String) -> HttpResponse {
        guard let url = Bundle.module.url(forResource: name, withExtension: ext),
              let data = try? Data(contentsOf: url) else {
            return .notFound
        }
        return JSONResponse.file(data, contentType: contentType)
    }

    // MARK: - Handlers

    private func health() -> HttpResponse {
        let dto = HealthDTO(
            ok: true,
            store: inspector.defaultStoreDescription,
            readOnly: readOnly,
            capabilities: readOnly ? ["read"] : ["read", "write"]
        )
        return JSONResponse.ok(dto)
    }

    private func contexts() -> HttpResponse {
        JSONResponse.ok(inspector.contexts)
    }

    private func allEntities(_ req: HttpRequest) -> HttpResponse {
        let q = queryDict(req.queryParams)
        let ctx = q["ctx"]
        do {
            return try JSONResponse.ok(inspector.entities(contextName: ctx))
        } catch let e as InspectError {
            return JSONResponse.error(e.statusCode, e.errorDescription ?? "error")
        } catch {
            return JSONResponse.error(500, error.localizedDescription)
        }
    }

    private func records(_ req: HttpRequest) -> HttpResponse {
        guard let rawName = req.params[":name"], !rawName.isEmpty else {
            return JSONResponse.error(400, "missing entity name")
        }
        let name = rawName.removingPercentEncoding ?? rawName
        let q = queryDict(req.queryParams)
        let ctx = q["ctx"]
        let search = q["search"]
        let searchAttr = q["searchAttr"]
        let sort = q["sort"]
        let order = SortOrder(rawValue: q["order"] ?? "asc") ?? .asc
        let limit = Int(q["limit"] ?? "100") ?? 100
        let offset = Int(q["offset"] ?? "0") ?? 0

        do {
            let dto = try inspector.records(
                contextName: ctx,
                entityName: name,
                search: search,
                searchAttr: searchAttr,
                sort: sort,
                order: order,
                limit: limit,
                offset: offset
            )
            return JSONResponse.ok(dto)
        } catch let e as InspectError {
            return JSONResponse.error(e.statusCode, e.errorDescription ?? "error")
        } catch {
            return JSONResponse.error(500, error.localizedDescription)
        }
    }

    private func detail(_ req: HttpRequest, export: Bool) -> HttpResponse {
        let q = queryDict(req.queryParams)
        guard let id = q["id"], !id.isEmpty else {
            return JSONResponse.error(400, "missing `id` query param")
        }
        let ctx = q["ctx"]
        do {
            let dto = try inspector.detail(contextName: ctx, id: id)
            if export {
                let shortID = (URL(string: dto.id)?.lastPathComponent) ?? "record"
                let filename = "\(dto.entity)-\(shortID).json"
                let extra: [String: String] = [
                    "Content-Disposition": "attachment; filename=\"\(filename)\""
                ]
                return JSONResponse.ok(dto, extraHeaders: extra)
            }
            return JSONResponse.ok(dto)
        } catch let e as InspectError {
            return JSONResponse.error(e.statusCode, e.errorDescription ?? "error")
        } catch {
            return JSONResponse.error(500, error.localizedDescription)
        }
    }

    private func queryDict(_ params: [(String, String)]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in params {
            let key = k.removingPercentEncoding ?? k
            let val = v.removingPercentEncoding ?? v
            if out[key] == nil { out[key] = val }
        }
        return out
    }
}
