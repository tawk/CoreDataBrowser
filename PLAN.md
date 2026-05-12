# CoreDataBrowser — embedded web-based Core Data browser

## Context

`/private/tmp/cdv` is an empty SwiftUI iOS app (iOS 26.4 deployment, bundle `to.tawk.cdv`, strict-concurrency `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`). The user wants a modern alternative to [iOS-Hierarchy-Viewer](https://github.com/damian-kolakowski/iOS-Hierarchy-Viewer) scoped to **only** the Core Data browser feature, distributable via Swift Package Manager.

Unlike the original tool's in-app UI, this version boots an embedded HTTP server inside the host app and exposes the Core Data store to a desktop browser on the same Wi-Fi network. The host app prints `http://<ip>:<port>` to the console at launch (typically guarded by `#if DEBUG`). The web UI is **read-only in v1**; the architecture leaves room for full CRUD in a future version without breaking the public API. Refresh is **manual** — clicking a refresh button in the web UI re-fetches the current view.

This plan covers the SPM package, a worked-out demo wired into `cdv` with a small seeded Core Data store, and the documentation a consumer needs to install and use the package.

## Repo layout

```
/private/tmp/cdv/
├── CoreDataBrowser/                   ← Swift Package (NEW)
│   ├── Package.swift
│   ├── README.md                            ← user-facing install + usage docs
│   ├── Sources/CoreDataBrowser/
│   │   ├── CoreDataBrowserServer.swift     ← public API
│   │   ├── Server/
│   │   │   ├── HTTPRouter.swift             ← Swifter wrapper, routes, MIME, errors
│   │   │   ├── JSONResponse.swift           ← shared JSONEncoder + response helpers
│   │   │   └── NetworkInterfaces.swift      ← getifaddrs → [String]
│   │   ├── Inspector/
│   │   │   ├── CoreDataInspector.swift     ← queries against NSManagedObjectContext
│   │   │   ├── EntityDTO.swift             ← Codable shapes returned by API
│   │   │   └── ValueEncoding.swift         ← NSManagedObject → JSON
│   │   └── Resources/
│   │       ├── index.html                  ← single-page web UI
│   │       ├── app.css
│   │       └── app.js
│   └── Tests/CoreDataBrowserTests/
│       └── CoreDataInspectorTests.swift    ← in-memory store + DTO shape tests
├── cdv/                               ← demo app
│   ├── cdvApp.swift                        ← MODIFIED: start server in DEBUG
│   ├── ContentView.swift                   ← MODIFIED: show printed URLs in-app
│   ├── Persistence.swift                   ← NEW: NSPersistentContainer
│   ├── Model.xcdatamodeld/                 ← NEW: Author/Book/Tag entities
│   ├── SeedData.swift                      ← NEW: inserts sample rows once
│   └── Assets.xcassets/
└── cdv.xcodeproj                      ← MODIFIED: add local SPM package + link
```

The `cdv` target uses `PBXFileSystemSynchronizedRootGroup`, so adding files inside `cdv/` auto-includes them in the build — only the project's package reference and the framework link need explicit pbxproj edits.

## Public API (SPM package)

```swift
import CoreData

public final class CoreDataBrowserServer: @unchecked Sendable {

    public struct Options: Sendable {
        /// Preferred port. If busy, the server tries `port + 1` up to `port + 10`.
        public var port: UInt16 = 8080
        /// Bind address: `.loopback` (127.0.0.1 only) or `.allInterfaces` (0.0.0.0).
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
        /// Every URL the server can be reached at, e.g.
        /// `http://192.168.1.42:8080`, `http://127.0.0.1:8080`.
        public let urls: [URL]
    }

    /// - Parameter context: The managed object context to browse. All access happens
    ///   inside `context.perform { … }`, so any context kind (viewContext, private
    ///   queue context) is safe.
    public init(context: NSManagedObjectContext, options: Options = .init())

    /// Binds and starts the server. Returns once the listener is accepting.
    /// Throws if no port in `port…port+10` could be bound.
    @discardableResult
    public func start() throws -> RunningInfo

    public func stop()

    public var isRunning: Bool { get }
    public var runningInfo: RunningInfo? { get }
}
```

Notes:
- `@unchecked Sendable` because the server holds a `Swifter.HttpServer` (non-Sendable) and an `NSManagedObjectContext` (which we only touch via `perform`). Internal mutable state is guarded by a serial `DispatchQueue`.
- The host can run multiple `CoreDataBrowserServer` instances on different ports if it has more than one context worth inspecting (e.g. main + background).

## HTTP API (consumed by the bundled web UI)

All responses are JSON unless noted. JSON is encoded with one shared encoder: `dateEncodingStrategy = .iso8601`, `outputFormatting = [.sortedKeys]`. Manual refresh = the client re-issues these requests.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/` | bundled `index.html` (text/html) |
| `GET` | `/app.css` | text/css |
| `GET` | `/app.js` | application/javascript |
| `GET` | `/api/health` | `{ ok, store, readOnly, capabilities:["read"] }` |
| `GET` | `/api/entities` | `[{ name, count, attributes:[{name,type,optional}], relationships:[{name,destination,toMany}] }]` |
| `GET` | `/api/entities/:name?search=&searchAttr=&sort=&order=asc\|desc&limit=100&offset=0` | `{ total, offset, limit, rows:[{ id, summary, attrs:{…} }] }` |
| `GET` | `/api/object?id=<uri>` | `{ id, entity, attrs, relationships:[{name, toMany, count, items:[{id, summary, entity}]}] }` |
| `GET` | `/api/object/export?id=<uri>` | same payload + `Content-Disposition: attachment; filename="<entity>-<shortID>.json"` |

`id` is the URL-encoded `NSManagedObjectID.uriRepresentation().absoluteString` (e.g. `x-coredata://<store-uuid>/Author/p1`). The inspector recovers the object via `persistentStoreCoordinator.managedObjectID(forURIRepresentation:)`. Using a query param avoids Swifter's path-segment splitting on `/` inside the encoded URI.

**Error responses** (all JSON `{ "error": "<message>" }`):
- `400` — invalid query param (unknown sort attribute, search on non-string attribute, missing `id`)
- `404` — entity name not in model, or object URI doesn't resolve to a row
- `405` — write method (`POST/PATCH/PUT/DELETE`) while `readOnly = true`
- `500` — fetch failure (Core Data error description in the message)

## Web UI (Resources/index.html + app.js + app.css)

- Single page, vanilla JS, **no external CDN** (works on devices without internet).
- Three-pane layout:
  1. Left: entity list (name + count). Clicking sets the active entity.
  2. Middle: records for the active entity. A toolbar with: search input, attribute dropdown (only string attrs), sort dropdown (any attribute), order toggle, page-size selector, prev/next pagination.
  3. Right: record detail. Attributes table. Relationships listed; clicking a related object navigates into it via History API (back button works).
- Top toolbar: **Refresh** (re-fetches current view), **Export JSON** (downloads `/api/object/export?...`), a `read-only` chip (placeholder for future CRUD).
- Styling: dark/light auto via `prefers-color-scheme`, system font stack, no framework. Resizable side panes.
- The web UI hits the JSON API only; no server-side templating. This keeps `app.js` swappable without touching Swift.

## Core Data inspection details

All inspection runs inside `context.perform { … }` and resolves a Swift result back to the request-handling thread via a `DispatchSemaphore`/`Result` bridge (Swifter expects a synchronous return from each route). The inspector:

- Lists entities from `context.persistentStoreCoordinator.managedObjectModel.entities`; filters out abstract entities; uses `name` non-nil.
- For counts uses `NSFetchRequest<NSNumber>` with `resultType = .countResultType` and `count(for:)`.
- For list rows uses one `NSFetchRequest<NSManagedObject>` per request, with:
  - `predicate` constructed only when `searchAttr` is a string attribute on the entity. Uses `NSPredicate(format: "%K CONTAINS[cd] %@", attr, search)`. Reject otherwise with 400.
  - `sortDescriptors`: validates `sort` is a real attribute name on the entity. Falls back to `objectID` ordering when missing.
  - `fetchLimit` (capped to 500), `fetchOffset`.
- For attribute encoding (`ValueEncoding.swift`):
  - String/Bool/Int16/Int32/Int64/Double/Float/Decimal → as-is (Decimal as string to preserve precision)
  - Date → ISO 8601
  - URI/UUID → string
  - Binary/Transformable → `{ "type": "binary", "bytes": <count> }` (don't dump blobs)
  - `nil` → JSON null
- For relationship rendering: to-one → `{ id, summary, entity }` or null; to-many → `{ count, items:[…] }` showing the first 20 summaries (full list not needed for the detail view).
- "Summary" string for a record: first non-empty `String` attribute, else `<EntityName> p<shortID>`. Cheap; good enough for an inspector.

## Threading model

Swifter handles each request on its own thread. Each handler:

```swift
return router.json {
    try inspector.perform { ctx in        // wraps context.perform with throwing Result
        // Core Data work, returns Encodable DTO
    }
}
```

`CoreDataInspector.perform` is implemented as:

```swift
func perform<T>(_ work: @escaping (NSManagedObjectContext) throws -> T) throws -> T {
    var result: Result<T, Error>!
    let sem = DispatchSemaphore(value: 0)
    context.perform {
        result = Result { try work(context) }
        sem.signal()
    }
    sem.wait()
    return try result.get()
}
```

This blocks the Swifter thread, not the main thread. Acceptable for a debug tool. Each request is independent; concurrent requests share the context's serial queue, so they queue up — safe.

## Network address discovery

`NetworkInterfaces.swift` wraps `getifaddrs()` and yields IPv4 addresses for non-loopback interfaces. Returns:
- `127.0.0.1` (always)
- Each non-loopback IPv4 found (typically `en0` Wi-Fi on device; `en0`/`en1` on Mac for simulator)

`RunningInfo.urls` is `addresses.map { URL(string: "http://\($0):\(port)")! }`. Surfaced to the host so it can render them in `ContentView` (helpful when the console isn't visible).

## Package.swift

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CoreDataBrowser",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .macCatalyst(.v15)],
    products: [
        .library(name: "CoreDataBrowser", targets: ["CoreDataBrowser"]),
    ],
    dependencies: [
        .package(url: "https://github.com/httpswift/swifter.git", from: "1.5.0"),
    ],
    targets: [
        .target(
            name: "CoreDataBrowser",
            dependencies: [.product(name: "Swifter", package: "swifter")],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "CoreDataBrowserTests",
            dependencies: ["CoreDataBrowser"]
        ),
    ]
)
```

**Why Swifter:** small (~2k LOC) pure-Swift HTTP server on SPM, handles HTTP/1.1, routing, query parsing, static files. Reliability + speed-of-implementation beats a hand-rolled `NWListener` parser for this debug-tool use case. Future versions can swap in Network.framework without changing the public API.

---

## Documentation — `CoreDataBrowser/README.md` (full content spec)

The README is what consumers see when they add the package. It must cover everything below.

### 1. Overview
One-paragraph pitch + screenshot placeholder (`docs/screenshot.png` — TBD, plan doesn't include capturing one).

### 2. Requirements
- iOS 15+, macOS 12+, tvOS 15+, Mac Catalyst 15+
- Swift 5.9+
- A Core Data `NSManagedObjectContext` (any kind)
- Local Wi-Fi between the device and the machine running the browser

### 3. Installation

**Xcode (recommended):**
1. File → Add Package Dependencies…
2. Enter the package URL: `https://github.com/<you>/CoreDataBrowser.git` (or the local path of the `CoreDataBrowser/` folder for in-repo use)
3. Add `CoreDataBrowser` to your app target.

**Local package (this repo's setup):**
The demo app in `/private/tmp/cdv` consumes the package from the sibling `CoreDataBrowser/` directory. To wire it up in `Package.swift`:
```swift
dependencies: [
    .package(path: "../CoreDataBrowser")
]
```
Or in Xcode: File → Add Package Dependencies → Add Local… → select `CoreDataBrowser/`.

**Package.swift:**
```swift
dependencies: [
    .package(url: "https://github.com/<you>/CoreDataBrowser.git", from: "1.0.0")
],
targets: [
    .target(name: "MyApp", dependencies: ["CoreDataBrowser"])
]
```

### 4. Quick start

```swift
import SwiftUI
import CoreData
import CoreDataBrowser

@main
struct MyApp: App {
    let persistence = PersistenceController.shared
    #if DEBUG
    @State private var browserInfo: CoreDataBrowserServer.RunningInfo?
    private let browser: CoreDataBrowserServer
    init() {
        browser = CoreDataBrowserServer(context: persistence.container.viewContext)
    }
    #endif

    var body: some Scene {
        WindowGroup {
            ContentView()
                #if DEBUG
                .onAppear { browserInfo = try? browser.start() }
                .environment(\.cdBrowserURLs, browserInfo?.urls ?? [])
                #endif
        }
    }
}
```

Console output on launch:
```
CoreDataBrowser: http://192.168.1.42:8080
CoreDataBrowser: http://127.0.0.1:8080
```
Open either URL from a desktop browser on the same network.

### 5. Configuration

```swift
var opts = CoreDataBrowserServer.Options()
opts.port = 9000
opts.bindAddress = .loopback   // only reachable from this device — pair with `xcrun simctl` port-forwarding
let server = CoreDataBrowserServer(context: ctx, options: opts)
```

### 6. iOS Info.plist notes

**Not required** for the basic case (inbound TCP listening on a non-privileged port):
- `NSAppTransportSecurity` exceptions — ATS applies to **outbound** HTTP only.
- `NSLocalNetworkUsageDescription` — required for outbound mDNS / `.local` browsing, not for passive listening.

**Recommended** to add anyway (improves reliability on physical devices and prepares for future Bonjour support):
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>Allow this debug build to expose its Core Data store to your local network.</string>
```

### 7. Security
- **Never ship this in production builds.** Wrap usage in `#if DEBUG`.
- The server has **no authentication**. Anyone on the same Wi-Fi can read the entire store.
- Read-only in v1 limits damage if a build accidentally exposes the server, but assume any field can be exfiltrated.
- For higher safety, set `bindAddress = .loopback` and forward a port from your Mac to the simulator if needed.

### 8. Troubleshooting
- **"Can't reach the URL from my laptop"**: check both devices are on the same network (and that the network isn't AP-isolated, e.g. some hotel/guest Wi-Fis). Try the IP printed for `en0`; ignore IPv6.
- **"Port already in use"**: the server retries `port + 1` up to `port + 10`. If all are busy, `start()` throws. Pass a different `port`.
- **"Refreshing doesn't show my latest changes"**: the server reads through the context you handed it. If you write on a private background context that doesn't merge into `viewContext`, hand the background context to the server instead, or fix your merge policy.
- **"On the simulator I see `127.0.0.1` only"**: simulator shares the Mac's network stack — that IP works from the host. From another machine, use the Mac's LAN IP.
- **VPN / iCloud Private Relay**: can route LAN traffic unexpectedly. Disable for testing.

### 9. Roadmap
- v1.0: Read-only browser (this version).
- v1.1: Bonjour advertising (`_cdbrowser._tcp.`).
- v2.0: CRUD — edit attributes, delete records, save context. Activated via `Options.readOnly = false`. Web UI exposes write affordances when `/api/health` reports `capabilities: ["read","write"]`. No public API breakage.

### 10. License
TBD.

---

## Demo app changes (`cdv/`)

1. **`Model.xcdatamodeld`** — three entities to exercise relationships and types:
   - `Author` (`name: String`, `bio: String?`, `birthDate: Date?`, books: `Book` to-many inverse)
   - `Book` (`title: String`, `pageCount: Int32`, `publishedAt: Date?`, `summary: String?`, `author: Author` to-one, `tags: Tag` to-many)
   - `Tag` (`name: String`, books: `Book` to-many inverse)
2. **`Persistence.swift`** — `NSPersistentContainer(name: "Model")`, `viewContext.automaticallyMergesChangesFromParent = true`. Async-safe singleton.
3. **`SeedData.swift`** — `seedIfEmpty(viewContext:)` inserts 3 authors / ~10 books / 5 tags so there's something to browse.
4. **`cdvApp.swift`** — on launch: seed, start `CoreDataBrowserServer`, hand `RunningInfo.urls` to `ContentView` via `@State`. Wrap in `#if DEBUG`.
5. **`ContentView.swift`** — replaces hello-world: shows server status, the list of URLs (long-press to copy), and an "open from your laptop's browser on the same Wi-Fi" instruction. No browser UI in-app.

## Critical files to be created / modified

**Created (package):**
- `CoreDataBrowser/Package.swift`
- `CoreDataBrowser/README.md`
- `CoreDataBrowser/Sources/CoreDataBrowser/CoreDataBrowserServer.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Server/HTTPRouter.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Server/JSONResponse.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Server/NetworkInterfaces.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Inspector/CoreDataInspector.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Inspector/EntityDTO.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Inspector/ValueEncoding.swift`
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/index.html`
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/app.css`
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/app.js`
- `CoreDataBrowser/Tests/CoreDataBrowserTests/CoreDataInspectorTests.swift`

**Created (demo):**
- `cdv/Persistence.swift`
- `cdv/SeedData.swift`
- `cdv/Model.xcdatamodeld/Model.xcdatamodel/contents`

**Modified:**
- `cdv/cdvApp.swift` — start server in DEBUG; pass `RunningInfo` to `ContentView`
- `cdv/ContentView.swift` — show server status + URL list
- `cdv.xcodeproj/project.pbxproj` — add `XCLocalSwiftPackageReference` pointing at `CoreDataBrowser/`; add `XCSwiftPackageProductDependency` for `CoreDataBrowser` and link it to the `cdv` target

## Forward-compatibility note (future CRUD)

Internal architecture is split so v2 adds only new code:
- New `PATCH /api/object` and `DELETE /api/object` routes in `HTTPRouter`, gated by `Options.readOnly == false`.
- A mutating counterpart `CoreDataMutator` performing edits inside `context.perform` + `save()`.
- New "Edit" UI in `app.js` swaps the read-only chip for write affordances when `/api/health` returns `capabilities: ["read","write"]`.

Public API stays source- and ABI-compatible.

## Verification

End-to-end checks before declaring done:

1. **Package builds standalone:**
   ```
   cd /private/tmp/cdv/CoreDataBrowser && swift build && swift test
   ```
2. **App builds for simulator:**
   ```
   xcodebuild -project /private/tmp/cdv/cdv.xcodeproj \
     -scheme cdv \
     -destination 'platform=iOS Simulator,name=iPhone 16' \
     build
   ```
3. **Run on simulator** (boot, launch, capture console):
   ```
   xcrun simctl boot "iPhone 16" || true
   xcrun simctl install booted <path-to-built-app>
   xcrun simctl launch --console booted to.tawk.cdv
   ```
   Expect: `CoreDataBrowser: http://192.168.x.x:8080` and `http://127.0.0.1:8080` printed; same URLs visible in the in-app `ContentView`.
4. **From desktop browser** at `http://127.0.0.1:8080`:
   - Entity list shows Author, Book, Tag with counts > 0.
   - Click Book → see seeded titles. Search "the" → list narrows. Sort by `pageCount desc` → order changes. Pagination changes the visible rows.
   - Click a book → detail shows attributes; relationships show its author and tags. Click the author → navigate to that record; its `books` to-many lists the seeded books.
   - Click Export → downloads `Book-<shortID>.json` with attrs + relationships.
   - Click Refresh → re-fetches without page reload.
5. **API smoke tests** via curl:
   ```
   curl -s http://127.0.0.1:8080/api/health | jq
   curl -s http://127.0.0.1:8080/api/entities | jq
   curl -s 'http://127.0.0.1:8080/api/entities/Book?sort=title&order=asc&limit=5' | jq
   curl -s -X DELETE http://127.0.0.1:8080/api/object | head    # expect 405
   ```
6. **Manual device test** (user does this): run on a physical device on the same Wi-Fi, open the non-loopback URL from a laptop browser, confirm same flow.

---

# v1.1 — Lab view

> Status: v1.0 (above) is implemented and runs on simulator + device. v1.1 is the work this section plans.

## Context

The current "Inspector" view (3 panes: entities · records · detail) is the only browse experience. The user wants a second, denser 5-pane layout with a real data grid, a per-row relationships sub-panel, and a content viewer pane. The Inspector view stays for users who prefer it; a top-bar toggle picks between them. The choice is remembered per browser via `localStorage`.

Out of scope for this iteration (deferred): content auto-detection (HTML/XML/JSON/image/URL), predicate builder, object model diagram, CSV export, binary blob endpoint, change tracking. All of these were considered and explicitly cut to keep the scope on the headline ask: the new layout + the data grid.

## Goals

1. Add a **5-pane Lab view** at `/lab`, served from the existing embedded server.
2. Provide a **data grid** in the center: sortable, resizable, reorderable, hideable columns, with prefs persisted per entity in `localStorage`.
3. Bottom-left **Relationships** sub-panel: dropdown picks a relationship of the selected row, lists items, click to navigate.
4. Bottom-right **Content** sub-panel: dropdown picks an attribute of the selected row, shows its raw value (text / pretty-printed JSON when the value is already structured). No magic auto-detection in this iteration.
5. Right **Detail** inspector: vertical attribute list + relationship summaries, with the existing **Export JSON** button.
6. **Top-bar toggle** between Inspector and Lab, present on both pages. Selection remembered in `localStorage` and used to default subsequent visits.
7. **No new server endpoints**. All data comes from the existing `/api/entities`, `/api/entities/:name`, `/api/object`, `/api/object/export`.

## File layout (under `CoreDataBrowser/Sources/CoreDataBrowser/Resources/`)

```
Resources/
├── index.html       ← existing Inspector page (toolbar gains Inspector/Lab tabs)
├── app.css          ← existing Inspector styles (gains shared top-bar tab styles)
├── app.js           ← existing Inspector logic (tiny additions: remember last view)
├── lab.html         ← NEW — Lab view shell
├── lab.css          ← NEW — Lab view styles
└── lab.js           ← NEW — Lab view logic (grid, panes, prefs)
```

Critical Swift change: `HTTPRouter.swift` gains four GET routes (`/lab`, `/lab.html`, `/lab.css`, `/lab.js`) that serve the new resources through `Bundle.module`. The static-asset helper (`serveResource`) already exists — reuse it.

## Pane layout (Lab view)

```
+----------------------------------------------------------+
| [Inspector] [Lab] *active*           ↻ Refresh   ⬇ Export |
+--------+------------------------------------+------------+
| ENTITY |  records grid (sticky header)      |  DETAIL    |
|        |                                    |  (right)   |
|        +------------------------------------+            |
|        | RELATIONSHIPS    | CONTENT VIEWER  |            |
|        | (bottom-left)    | (bottom-right)  |            |
+--------+------------------------------------+------------+
```

- **Sidebar (left, ~220 px, horizontally resizable):** entity list with row counts. Click selects entity.
- **Grid (center top, flex):** records of the active entity. Sticky header. Each attribute is a column. A "select" column on the left highlights the active row.
- **Relationships (bottom-left, ~50% of bottom row):** dropdown picks one of the selected row's relationships; lists items; click navigates.
- **Content viewer (bottom-right):** dropdown picks one of the selected row's attributes; renders value. Pretty-prints JSON when the value is an object DTO (`binary`/`transformable`). Plain text otherwise.
- **Detail panel (right, ~320 px, horizontally resizable):** every attribute name+value, then a relationships summary. Houses the Export JSON button.
- **Splitters:** between sidebar/center, between grid/bottom-row, between bottom-left/bottom-right, and between center/detail. Pointer-drag (pointerdown / pointermove / pointerup; use `pointer-events: none` on the rest of the page during a drag to avoid hover flicker), with sizes persisted to `localStorage["cdb.lab.panes"]`.
- **Pane minimums:** each pane has a `min-width`/`min-height` (sidebar ≥ 160 px, detail ≥ 240 px, grid ≥ 200 px wide × 120 px tall, each bottom sub-panel ≥ 200 px wide × 100 px tall) — splitter handlers clamp to these so the user can't collapse a pane to zero. To fully hide a sub-panel, a future iteration could add an explicit collapse button; out of scope here.

## Data grid behavior

- **Columns:** one per attribute. Default order = attribute name sort (matches existing API). Header shows `<name>` with a small `· <type>` muted suffix.
- **Default sizing:** if no width is stored, each column uses `min-width: 80px; max-width: 360px; width: auto` (let the browser size it within those bounds based on content). Once the user drags to resize, the explicit width takes precedence and is persisted.
- **Sticky header:** `<thead> th { position: sticky; top: 0; z-index: 1 }` requires the grid container itself to be the scroll context (`overflow: auto` on the pane wrapper, not on `<table>` directly). Note this for the frontend-design pass.
- **Sort:** click header → asc, click again → desc, click again → unsorted (server-side `sort=` + `order=`). Active sort drawn with a ▲/▼ indicator.
- **Resize:** pointer-drag on the right edge of each header cell. Stored as `widths[attr]` (px) in localStorage key `cdb.lab.cols.<EntityName>`.
- **Reorder:** drag header cell. Implementation may use HTML5 DnD (`draggable=true` + `dragover` + `drop`) or pointer events; pointer events are usually less janky for in-page reordering because HTML5 DnD requires fighting `dragstart` images and `dragover.preventDefault()` quirks. Let the frontend-design pass choose. Persisted as `order:[attr,…]`.
- **Hide / Show:** right-click (or context-menu button) on a header → "Hide column". A "Columns ▾" menu in the grid toolbar lists every attribute with a checkbox; toggling restores or hides columns. Persisted as `hidden:[attr,…]`.
- **Pagination + search + searchAttr:** identical to Inspector — toolbar above the grid carries the same controls (search input, search-attr dropdown, page-size selector, prev/next buttons, page indicator), plus the new **Columns ▾** menu.
- **Row click:** populates Detail, Relationships, and Content panes for that record.
- **Row hover:** subtle background using existing `--bg-elev`. Selected row uses `--accent-bg`. Double-click opens the same record at `/?id=<uri>` in a new tab.

LocalStorage shape (one key per entity):
```json
{
  "order": ["title", "pageCount", "publishedAt", "summary"],
  "widths": { "title": 280, "pageCount": 80 },
  "hidden": ["summary"]
}
```

Missing keys mean defaults; never throw on a malformed value, just fall back.

## Selection & navigation model

- Lab view holds four slots: `entity`, `rowId`, `attrInContentViewer`, `relationshipInRelationsPanel`.
- Selecting a row updates the row slot; the relations/content panes default to the first relationship/attribute respectively, but remember the user's last choice for that entity in localStorage.
- Clicking a related record (relationships sub-panel or detail panel) replaces `rowId` with the target object's id and updates Detail + sub-panels accordingly. The grid scrolls to the row if it's in the current page; otherwise the user sees the detail without re-paginating.
- URL reflects state: `/lab?entity=Book&id=<uri>`. `popstate` restores it. History entries are pushed only on user-initiated record selects (matches Inspector behaviour).
- **Performance:** grid renders the current page in one pass; re-renders only on entity change, sort/filter/page change, or column-config change. No virtualization (a page is ≤ 200 rows). Row selection updates the selected-row class only, not the whole grid.
- **Edge case — narrow viewport:** Lab view targets desktop browsers. On a viewport narrower than ~900 px the layout will overflow horizontally with a scrollbar; we don't auto-collapse panes. The Inspector view remains the better choice on phones/tablets.

## Top-bar toggle & shared header

- `index.html` and `lab.html` each render the toolbar inline. The two tabs `[Inspector] [Lab]` are simple anchors (`href="/"`, `href="/lab"`); the active one carries an `aria-current="page"` and styled accent.
- On any toggle click, set `localStorage["cdb.preferredView"]` to the chosen view. `app.js` reads this on `/` and stays put; `lab.js` does the same.
- For users who land on `/` after previously using Lab, optionally prompt-free auto-redirect — **skipped in this iteration** to keep `/` a stable, predictable URL.

## Server changes (`Sources/CoreDataBrowser/Server/HTTPRouter.swift`)

Reuse `serveResource(_:ext:contentType:)`. Add inside `wire()`:

```swift
server.GET["/lab"]      = { [weak self] _ in self?.serveResource("lab", ext: "html", contentType: "text/html; charset=utf-8") ?? .notFound }
server.GET["/lab.html"] = { [weak self] _ in self?.serveResource("lab", ext: "html", contentType: "text/html; charset=utf-8") ?? .notFound }
server.GET["/lab.css"]  = { [weak self] _ in self?.serveResource("lab", ext: "css", contentType: "text/css; charset=utf-8") ?? .notFound }
server.GET["/lab.js"]   = { [weak self] _ in self?.serveResource("lab", ext: "js", contentType: "application/javascript; charset=utf-8") ?? .notFound }
```

No new JSON endpoints. No new DTOs. No public Swift API changes.

## Inspector view (existing) — small updates

- Add Inspector/Lab tabs to its top bar (mirror lab.html). **Keep the existing Refresh and Export JSON buttons unchanged** — the tabs slot in next to the brand chip on the left, controls stay on the right.
- `app.js`: on page load, write `cdb.preferredView = "inspector"`. No other behaviour changes.
- `app.css`: add styles for the shared `.view-tabs` element. **No new color tokens** — Lab view reuses every CSS variable already defined in `app.css` (`--bg`, `--bg-elev`, `--fg`, `--fg-dim`, `--border`, `--accent`, `--accent-bg`, `--danger`, `--mono`, `--sans`). Where Lab needs new accents (e.g. selected-row tint), derive from existing tokens, don't introduce new ones.

## frontend-design skill plan

Per the directive ("when working with web content (http, css, js) use frontend-design plugin/skill"), invoke the skill three times — once per coherent UI piece — so each round can iterate on details rather than firing one shot at the whole bundle:

1. **Lab view shell** — top-bar with Inspector/Lab tabs, 5-pane layout, splitters, empty states, sidebar, dark/light auto. Output: `lab.html` skeleton + `lab.css` for the shell and pane chrome.
2. **Data grid component** — sticky-header table, sortable/resizable/reorderable/hideable columns, sort indicator, drag-reorder affordance, resize handle, column-menu (Columns/Hide), pagination toolbar. Output: grid-specific CSS + JS helpers, integrated into `lab.js`.
3. **Detail + relationships + content panes** — right-side attribute list with Export, bottom-left relationships viewer dropdown + list, bottom-right content viewer with value renderer (text / pretty JSON / "binary" placeholder). Output: pane-specific CSS + JS, integrated into `lab.js`.

Each invocation should be given the project context (read-only Core Data inspector, no external CDN, dark/light auto, vanilla JS, no framework) and the shape of the JSON it will consume (the existing API).

## Critical files

**Created:**
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/lab.html`
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/lab.css`
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/lab.js`

**Modified:**
- `CoreDataBrowser/Sources/CoreDataBrowser/Server/HTTPRouter.swift` — add 4 routes (see snippet above).
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/index.html` — add Inspector/Lab tabs to the toolbar.
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/app.css` — add `.view-tabs` styles (and any minor token tweaks so both views share variables).
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/app.js` — write `cdb.preferredView = "inspector"` on load. No behaviour changes.
- `CoreDataBrowser/README.md` — update §1 (Overview) and §9 (Roadmap) to mention the Lab view; the rest is unchanged.

No Swift API breakage. No new SPM dependencies.

## Deferred (future iterations, captured for the roadmap)

- **Content auto-detection** (v1.2): JSON/XML/HTML/RTF/PLIST detection in the content viewer; image rendering when an attribute is a URL pointing at an image or a `Data` blob recognised as an image. Needs a `GET /api/object/blob?id=&attr=` endpoint that streams raw bytes for Data/Transformable attributes (rejecting absurdly large ones).
- **Predicate builder** (v1.3): All-of / Some-of / None-of multi-condition filter; operators per attribute type. Server-side: `POST /api/entities/:name/query` accepting a JSON predicate spec that the inspector converts to `NSPredicate` safely (allowlist of operators + key paths).
- **Object model diagram** (v1.4): force-directed schema graph, SVG export, pure client.
- **CSV export** (v1.5): `?format=csv` on the records endpoint.
- **Change tracking** (v2+): per-row colours for created/changed/deleted records; requires server-side snapshot diffing between refreshes (or persistent history tracking on the host's Core Data stack).

These are not committed; they are listed so the v1.1 work doesn't accidentally close the door on them. The current public Swift API and JSON shapes remain forward-compatible with all of these.

## Verification (v1.1)

1. **Package builds:** `cd CoreDataBrowser && swift build` (no new deps; should be a no-op on resolved cache).
2. **Routes resolve:**
   ```
   curl -sI http://127.0.0.1:8080/lab     | head -3   # 200, text/html
   curl -sI http://127.0.0.1:8080/lab.css | head -3   # 200, text/css
   curl -sI http://127.0.0.1:8080/lab.js  | head -3   # 200, application/javascript
   ```
3. **Top-bar toggle:** open `/`, click "Lab", land on `/lab` with active tab styled differently; reverse works. localStorage shows `cdb.preferredView` updated.
4. **Lab grid:** pick `Book` entity; grid renders columns for every attribute; sticky header stays on scroll.
5. **Column ops:**
   - Click `title` header → sort asc (▲); click again → desc (▼); click again → unsorted.
   - Drag `pageCount` header right of `summary` → order persists across reload.
   - Drag right edge of `title` to widen → width persists.
   - Right-click `summary` header → Hide → column disappears; "Columns" menu lets you restore it.
   - LocalStorage key `cdb.lab.cols.Book` reflects each change.
6. **Selection cascades:** click a Book row → Detail shows attrs + relationships, Relationships sub-panel shows `author` (default) and switches via the dropdown to `tags`; Content viewer dropdown defaults to first attribute and switches.
7. **Cross-record navigation:** click `author` in Relationships → grid switches to Author entity? Or just detail updates with that record? — **Decision: update Detail + sub-panels in place; do *not* auto-switch the active entity in the sidebar/grid.** Inspector-follows-the-gaze feel without the surprise of a grid jump.
8. **Pane sizes persist:** drag splitters → reload → sizes restored.
9. **Inspector view unchanged:** all v1.0 verification steps still pass.


---

# v1.2 — Theme refresh: SmartQuery-inspired

> Status: v1.0 and v1.1 are implemented. v1.2 is the work this section plans.

## Context

The user shared a screenshot of **SmartQuery** (by Simon Mathewson) and said "I like how this looks — apply it". SmartQuery's visual language is meaningfully different from the "sharp-cornered native designer-tool" mood that pass 1 of v1.1 locked in:

- **Dark only**, near-black app background (`~#0a0a0d`).
- **Rounded cards** — each panel is a `~10 px` rounded card sitting on the app bg with visible gaps around it.
- **Pill-shaped tabs** (fully rounded), the active one tinted blue.
- **No hairline borders** between list items; separation is purely via background tint.
- **Semantic colors** in tabular data: integer IDs in vivid blue, dates in muted amber, booleans green/dim, magenta reserved for syntax functions (e.g. `SUM`).
- **Soft, generous spacing** — Linear / Raycast feel rather than Xcode density.
- A subtle vivid blue accent (`~#4a8bff`) used sparingly for IDs, keywords, active states.

This iteration replaces the dark palette with a SmartQuery-derived one, rounds the layout, switches the view tabs to pills, removes sidebar hairlines, and adds semantic colors to grid cells. **Both views (Inspector + Lab) get the same treatment** so the top-bar toggle preserves the look.

## Out of scope

- **Light theme** — SmartQuery is dark-only. The existing `prefers-color-scheme: light` branch loses meaning under the new palette; drop it entirely for v1.2 (any light visit falls through to the dark palette). A future iteration can reintroduce a separately-designed light theme.
- **Markup changes** — all existing HTML stays.
- **JS / Swift / server changes** — none.
- **Inspector-view detail semantic colors** — the existing Inspector detail panel doesn't carry attribute types in markup, so it can't colour values by type without a JS change. Skip for v1.2; the Lab grid carries the type-aware colour story. Inspector picks up the palette + shapes only.

## Palette (replaces both `:root` blocks in `app.css` and `lab.css`)

Approximate values eyeballed from the screenshot — expect minor visual tuning during implementation.

```css
:root {
  --bg:           #0a0a0d;   /* app background, near-black */
  --bg-elev:      #16161a;   /* panel / card background */
  --bg-elev-2:    #1f1f24;   /* hover row, elevated controls */
  --fg:           #ededef;   /* primary text */
  --fg-dim:       #8b8b95;   /* secondary text, labels, unsorted indicators */
  --border:       #26262d;   /* the few remaining hairline dividers */
  --accent:       #4a8bff;   /* IDs, keywords, active states, links */
  --accent-bg:    #1a2447;   /* active pill / active row background tint */
  --danger:       #ff6b6b;
  --syntax-amber: #c8a050;   /* date cells */
  --syntax-pink:  #d6589a;   /* reserved for future syntax-function colour */
  --syntax-green: #7dcc6e;   /* boolean true */
  --mono:         /* unchanged */;
  --sans:         /* unchanged */;
}
```

The existing `@media (prefers-color-scheme: dark) { :root { … } }` override block is **removed** from both files. Same palette applies in every system theme.

## Visual changes (apply to both `app.css` and `lab.css`)

### 1. Pane-as-card layout
- `.layout`: add `padding: 8px; background: var(--bg);` so the app bg shows around panes.
- `.pane`: `border-radius: 10px; overflow: hidden; background: var(--bg-elev);` (already has bg).
- **Splitters supply the inter-card gap.** Bump `.splitter { flex: 0 0 6px }` (was 4px) and set `.splitter::after { opacity: 0 }` at rest — the app bg now shows in the gap. Hover/drag still flips the `::after` to `--accent; opacity: 1`. Apply to both `.splitter-v` and `.splitter-h`. Do **not** add `gap` to `.bottom-row` or the outer flex — that would add to the splitter's width and produce too-wide gaps.
- Inspector view's `.layout` (which uses CSS grid, not flex, and has no splitter elements): use `gap: 6px` on the grid alongside the `padding: 8px`.
- The 40px top-bar and 22px status-bar stay as full-width panel-coloured strips (no markup change). The card grid sits between them; the 8px padding on `.layout` gives the cards a uniform visible margin against the `--bg` ground.

### 2. Top-bar tabs → pills
Replace the underline-style view tabs with pill-shaped ones (matches the SmartQuery "genres / artists / invoices" pill aesthetic):

```css
.view-tabs { display: flex; gap: 4px; align-self: center; }
.view-tabs a {
  padding: 5px 14px;
  border-radius: 999px;
  color: var(--fg-dim);
  font-size: 13px;
  background: transparent;
  text-decoration: none;
  transition: background 100ms ease, color 100ms ease;
}
.view-tabs a:hover { background: var(--bg-elev-2); color: var(--fg); }
.view-tabs a[aria-current="page"] {
  background: var(--accent-bg);
  color: var(--accent);
}
```
The `.view-tabs a[aria-current="page"]::after` underline rule is **removed**.

### 3. Sidebar entity list (`.entity-list`) and `.rel-list`
- Remove `border-bottom: 1px solid var(--border)` from list items — no hairlines.
- Replace the active state's `box-shadow: inset 3px 0 0 var(--accent)` stripe with `background: var(--accent-bg); color: var(--accent);` (full tint, no stripe). The active row's `.count` already uses accent; keep it.
- Hover state stays `background: var(--bg-elev-2)` (no change).
- Apply the same rules to `.rel-list > li` and `.rel-item` (the Lab Relationships sub-panel + the in-detail card item rows).

### 4. Buttons + inputs — softer radii
- `.topbar button`, `.gt-btn`: `border-radius: 6px` (was 3–4px).
- `.gt-search`, `.gt-select`, `.pane-select`: `border-radius: 6px`.
- Hover/active states unchanged.

### 5. Grid table cells — semantic colors (Lab only — Lab grid renders the type info)
In `lab.css`'s Grid section, extend:
- `td.col-numeric { color: var(--accent); }` — Int/Float/Double/Decimal cells in blue.
- `td.col-date    { color: var(--syntax-amber); }` — Date cells in amber.
- `td.val-true    { color: var(--syntax-green); }` — booleans true in green (was accent).
- `td.val-false`, `td.val-null`, `td.val-binary` — unchanged.
- Header `<th>` text stays `--fg`; sort indicator stays `--accent`.

### 6. Popovers / context menu
`.cdb-popover { border-radius: 8px }` (was 4px). Inner rows unchanged. The existing `@media (prefers-color-scheme: dark) { .cdb-popover { box-shadow: ... } }` rule that adds the subtle bright ring in dark mode should be **un-nested** from the `@media` so it applies unconditionally (since the whole theme is now dark).

### 7. Status dot
Keep the existing green pulse — already matches SmartQuery's "running indicator" energy.

## Files to modify

- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/app.css` — palette tokens in `:root`, drop the dark `@media` block, `.layout { padding: 8px; gap: 6px; background: var(--bg) }`, `.pane { border-radius: 10px }`, `.view-tabs` → pills (remove the `::after` underline rule), sidebar/list-item `border-bottom` removed, list-item `.active` retuned to `background: var(--accent-bg); color: var(--accent)` (drop the inset stripe), button/select radius bumped to 6px.
- `CoreDataBrowser/Sources/CoreDataBrowser/Resources/lab.css` — same palette tokens (duplicated by design), drop dark `@media`, `.layout { padding: 8px; background: var(--bg) }`, `.pane { border-radius: 10px }`, splitter `flex-basis: 6px` and `::after { opacity: 0 }` at rest, `.view-tabs` → pills, button/input radius bumps (`.gt-btn`, `.gt-search`, `.gt-select`, `.pane-select`), grid cell semantic colours (`td.col-numeric`, `td.col-date`, `td.val-true`), `.entity-list > li` / `.rel-list > li` / `.rel-item` `border-bottom` removed + active state retuned, `.cdb-popover` radius 8px and its dark-mode `@media` un-nested.
- `CoreDataBrowser/README.md` — §1 Overview: if it currently says "dark/light auto via `prefers-color-scheme`", replace with a single-dark-theme statement. (Subagent may have rephrased it during v1.1; touch only if the phrase is present.)

No HTML changes. No JS changes. No Swift changes. No SPM dependency changes. The new CSS is picked up automatically on the next page load.

## Verification (visual)

1. Open `/lab`:
   - Near-black app bg around rounded card panes; visible gaps between sidebar, center, detail, and bottom sub-panes.
   - `[Inspector] [Lab]` tabs are pill-shaped; active "Lab" is tinted blue.
   - Sidebar entities have no horizontal lines; active entity is a full blue-tinted row with accent text + accent count.
   - Grid: `pageCount` column reads blue, `publishedAt` reads amber, any boolean `true` reads green. Strings are default white.
   - Buttons (Refresh, Export JSON, pagination, Columns ▾) softly rounded.
   - Splitter areas show the app bg between panes at rest; hover still flashes accent.
2. Open `/`:
   - Same palette, same rounded card panes, same pill tabs, same softer buttons.
3. Click between Inspector and Lab pills — the look stays cohesive.
4. Set browser to "light" appearance — the page still renders dark (no light variant in v1.2).
5. All existing v1.0 + v1.1 behaviour (search, sort, column ops, splitter resize, history, exports) continues working — these are pure CSS changes.


---

# Relocation — move the package to `~/iOS/CoreDataBrowser`

## Context

`/private/tmp/cdv` lives on tmpfs and will be wiped at some point. The user wants the **package** (not the demo `cdv` app) preserved at `~/iOS/CoreDataBrowser`. They also want this Claude Code conversation/session to be resumable from the new location after the move.

## Q1 — Does the package need a whole Xcode project (i.e. an `.xcodeproj`)?

**No.** A Swift Package is self-contained — `Package.swift` at the root, `Sources/<Module>/` for code, `Resources/` referenced from `Package.swift`. There is no wrapping `.xcodeproj` today and there shouldn't be one. Editing options after the move:

- **Xcode**: `xed ~/iOS/CoreDataBrowser` (or `File → Open → select the folder`). Xcode opens it in "Swift Package" mode with full indexing, build, test, run, and resource preview.
- **Command line**: `cd ~/iOS/CoreDataBrowser && swift build` (and `swift test` if/when tests are added back).
- **Any editor**: it's just a folder of `.swift` / `.html` / `.css` / `.js` files plus `Package.swift`. VS Code with the Swift extension, Vim, etc. all work.

Wrapping the package in an Xcode app project would only be necessary to ship an executable target. The package itself is a library — no wrapper required.

## Q2 — Can a sample/demo app still consume it the same way?

**Yes**, identically to how `/private/tmp/cdv/cdv.xcodeproj` does today. Any consuming iOS app adds it as a **local SPM dependency**:

- **In Xcode**: *File → Add Package Dependencies → Add Local… → select* `~/iOS/CoreDataBrowser`. Xcode writes an `XCLocalSwiftPackageReference` whose `relativePath` is computed from the consuming project's location to `~/iOS/CoreDataBrowser`.
- **In `Package.swift`**: `.package(path: "/Users/ansis/iOS/CoreDataBrowser")` (or a relative path if the consumer also lives under `~/iOS/`).

The current `cdv` demo app at `/private/tmp/cdv/cdv*` is **out of scope per the user's instruction** — it stays where it is and will be wiped along with `/private/tmp`. After the move, the user can either:
1. Make a fresh sample app at `~/iOS/CoreDataBrowser-Sample/` (or anywhere) and add the local SPM dependency, or
2. Use any existing iOS project they already have for testing.

The package's `README.md` already documents both workflows in §3 *Installation*.

## What gets moved + renamed

There are three distinct things to relocate:

### 1. The package source
- **From**: `/private/tmp/cdv/CoreDataBrowser/`
- **To**:   `~/iOS/CoreDataBrowser/`  *(i.e. `/Users/ansis/iOS/CoreDataBrowser/`)*
- **Contents**: `Package.swift`, `README.md`, `Sources/CoreDataBrowser/{CoreDataBrowserServer.swift, Server/*, Inspector/*, Resources/*}`. The `.build/` cache can move along with it or be discarded — `swift build` will regenerate.

### 2. The plan file (rename + duplicate into the repo)
The current plan is auto-named `this-is-an-empty-curried-hamster.md` in `~/.claude-tawk/plans/`. Two endpoints to satisfy the user's "rename to CoreDataBrowser-init" and "copy session info into the folder" asks:

- **Rename in place**:  
  `~/.claude-tawk/plans/this-is-an-empty-curried-hamster.md` → `~/.claude-tawk/plans/CoreDataBrowser-init.md`
- **Also copy into the repo** as a discoverable doc:  
  `~/iOS/CoreDataBrowser/PLAN.md` (single canonical copy that lives with the code)

### 3. The Claude Code project state (so session resume works)
Claude Code stores per-project state in `~/.claude-tawk/projects/<encoded-cwd>/`. The encoding replaces `/` with `-`, so:

- Current dir: `~/.claude-tawk/projects/-private-tmp-cdv/` (2 session transcripts, subagents, tool-results)
- Target dir: `~/.claude-tawk/projects/-Users-ansis-iOS-CoreDataBrowser/`

Renaming the project state directory means that when the user runs `cd ~/iOS/CoreDataBrowser && claude --resume`, the existing session transcripts (including **this** session, `85d7dc7b-...jsonl`) will be listed and selectable. Without this step, resume from the new cwd won't find any sessions.

**Caveat**: the JSONL transcripts contain absolute paths to `/private/tmp/cdv/…` baked into the message bodies. Resume will work, but the assistant will need a one-liner from the user on resume — *"the package moved to ~/iOS/CoreDataBrowser, edit there"* — to redirect.

## Steps — automated this turn

`/private/tmp` is tmpfs/devfs and `~/iOS` is APFS, so `mv` here is a cross-filesystem operation — Unix `mv` falls back to copy-then-delete automatically; works fine, just takes a moment.

```bash
# 1. Create the target parent (idempotent)
mkdir -p ~/iOS

# 2. Move the package
mv /private/tmp/cdv/CoreDataBrowser ~/iOS/CoreDataBrowser

# 3. Repoint the README's "Local package" example away from /private/tmp/cdv
#    (the cdv demo app is being wiped; the paragraph should describe consuming
#     from ~/iOS/CoreDataBrowser instead)

# 4. Drop a copy of the plan inside the repo so it ships with the code
cp ~/.claude-tawk/plans/this-is-an-empty-curried-hamster.md ~/iOS/CoreDataBrowser/PLAN.md

# 5. Rename the original plan file (so it doesn't read as 'curried-hamster')
mv ~/.claude-tawk/plans/this-is-an-empty-curried-hamster.md ~/.claude-tawk/plans/CoreDataBrowser-init.md

# 6. Sanity check the package builds in its new home
cd ~/iOS/CoreDataBrowser && swift build
```

## Step — DO NOT automate; user runs after this session ends

The Claude Code project state directory holds **this session's live JSONL transcript** plus subagent state. Moving it mid-session is unsafe: file handles survive the rename via inode (Unix), but any post-rename state lookup Claude Code does by path (e.g. session listing, subagent registration) would miss it. So leave it for after the conversation truly ends:

```bash
# Run AFTER you've closed this Claude Code session
mv ~/.claude-tawk/projects/-private-tmp-cdv \
   ~/.claude-tawk/projects/-Users-ansis-iOS-CoreDataBrowser

cd ~/iOS/CoreDataBrowser
claude --resume        # this session should appear; pick session 85d7dc7b-…
```

If `--resume` doesn't list it, fall back: open a fresh session and say "read PLAN.md and continue from where v1.2 left off". The PLAN.md inside the repo captures all the architectural decisions.

## After the move — resuming this conversation

```bash
cd ~/iOS/CoreDataBrowser
claude --resume     # picks the renamed project state dir; lists this session
# Once the session loads, your first prompt should be:
#   "the package is now at ~/iOS/CoreDataBrowser (was /private/tmp/cdv/CoreDataBrowser).
#    continue from there."
```

If `--resume` doesn't list this session (Claude Code may key the session to something beyond just the dir name — uncertain without inspecting internals), the fallback is a fresh session in `~/iOS/CoreDataBrowser` where the assistant reads `PLAN.md` to bootstrap context.

## What does NOT move

- `/private/tmp/cdv/cdv*` (the demo iOS app + its `.xcodeproj`) — per user instruction. Will be deleted with tmp.
- The simulator instance `cdv-test` and its installed `to.tawk.cdv` app — were tied to the now-deleted demo project; safe to leave or `xcrun simctl delete cdv-test` later.

## Verification

After the in-session steps (1–6):
1. `ls -la ~/iOS/CoreDataBrowser/` shows `Package.swift`, `README.md`, `Sources/`, `PLAN.md`.
2. `cd ~/iOS/CoreDataBrowser && swift build` exits 0 (Swifter dep re-resolves to its cache if `.build/` was kept; otherwise re-fetches).
3. `xed ~/iOS/CoreDataBrowser` opens Xcode showing the package, with the bundled `Resources/{index,lab}.{html,css,js}` visible in the navigator and editable.
4. `ls ~/.claude-tawk/plans/` shows `CoreDataBrowser-init.md` (no longer `this-is-an-empty-curried-hamster.md`).
5. `grep -c '/private/tmp/cdv' ~/iOS/CoreDataBrowser/README.md` returns `0`.

After the manual post-session step:
6. `ls ~/.claude-tawk/projects/` shows `-Users-ansis-iOS-CoreDataBrowser/` (no longer `-private-tmp-cdv/`).
7. `cd ~/iOS/CoreDataBrowser && claude --resume` lists session `85d7dc7b-…` and resuming brings you back to this conversation.

## Not in this iteration

- Initialising a git repo (`git init`) at `~/iOS/CoreDataBrowser/` — left as a follow-up if the user wants version control.
- Publishing to a remote (`gh repo create`) — same.
- Creating a fresh sample/demo iOS app to replace the wiped `cdv` — same. The user can do this whenever they need to test the package against a host app.
