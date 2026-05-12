// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CoreDataBrowser",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
        .tvOS(.v15),
        .macCatalyst(.v15),
    ],
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
    ]
)
