import NatsumiCore
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The system's pickers for the photo library and the Files app, shown over whatever is on the screen when the
/// mediator asks the owner to choose files to attach (ADR 0071). What was chosen is read in here and handed back
/// once, all together; nothing is handed back when the owner cancels.
@MainActor
final class FilePickers: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    private var picked: (([PickedFile]) -> Void)?

    func present(_ source: AttachSource, picked: @escaping ([PickedFile]) -> Void) {
        // The UI tests cannot drive the system's pickers reliably; they attach made-up files instead.
        if ProcessInfo.processInfo.arguments.contains("-NatsumiPickExampleFiles") {
            picked(Self.examples())
            return
        }
        guard let top = Self.topController() else { return }
        self.picked = picked
        switch source {
        case .photos:
            var configuration = PHPickerConfiguration()
            configuration.filter = .images
            configuration.selectionLimit = 0
            let picker = PHPickerViewController(configuration: configuration)
            picker.delegate = self
            top.present(picker, animated: true)
        case .files:
            // A copy is made for the app, so the file can be read for as long as it takes to upload.
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            top.present(picker, animated: true)
        }
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = Providers(items: results.map(\.itemProvider))
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            Task { [weak self] in
                let files = await providers.photos()
                self?.hand(files)
            }
        }
    }

    /// The photos chosen. An item provider loads on its own queues and may be read from any thread.
    private struct Providers: @unchecked Sendable {
        let items: [NSItemProvider]

        nonisolated func photos() async -> [PickedFile] {
            var files: [PickedFile] = []
            for provider in items {
                if let file = await FilePickers.photo(provider) { files.append(file) }
            }
            return files
        }
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated { hand(urls.compactMap(Uploader.picked)) }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { picked = nil }
    }

    private func hand(_ files: [PickedFile]) {
        let picked = self.picked
        self.picked = nil
        if !files.isEmpty { picked?(files) }
    }

    /// A photo as the server can tell it is a picture: PNG, JPEG and WebP as they are, anything else (HEIC) as JPEG.
    nonisolated static func photo(_ provider: NSItemProvider) async -> PickedFile? {
        let base = provider.suggestedName ?? "photo"
        for (type, ext) in [(UTType.png, "png"), (.jpeg, "jpg"), (.webP, "webp")] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            if let data = await data(provider, type) {
                return PickedFile(name: "\(base).\(ext)", bytes: data.count, source: .data(data))
            }
        }
        guard let image = await withCheckedContinuation({ (done: CheckedContinuation<UIImage?, Never>) in
            _ = provider.loadObject(ofClass: UIImage.self) { object, _ in done.resume(returning: object as? UIImage) }
        }), let data = image.jpegData(compressionQuality: 0.9) else { return nil }
        return PickedFile(name: "\(base).jpg", bytes: data.count, source: .data(data))
    }

    nonisolated private static func data(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
        await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in done.resume(returning: data) }
        }
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// Two made-up files: a small picture of one color, and a short text.
    private static func examples() -> [PickedFile] {
        let picture = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).pngData { context in
            UIColor.systemYellow.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
        let text = Data("架空のメモです。\n".utf8)
        return [
            PickedFile(name: "example.png", bytes: picture.count, source: .data(picture)),
            PickedFile(name: "example.txt", bytes: text.count, source: .data(text)),
        ]
    }
}
