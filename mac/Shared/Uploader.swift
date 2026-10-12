import Foundation
import NatsumiCore
import UniformTypeIdentifiers

/// Uploads the files the owner attaches, and reads them in, for the root to hand back to the mediator (ADR 0071).
enum Uploader {
    /// The file on this device as the mediator takes it: its name and size. nil for a folder or what cannot be read.
    static func picked(_ url: URL) -> PickedFile? {
        guard url.isFileURL, let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true
        else { return nil }
        return PickedFile(name: url.lastPathComponent, bytes: values.fileSize ?? 0, source: .file(url))
    }

    /// Sends one file's bytes as they are. Whatever goes wrong on the way is a failure the owner can try again.
    static func upload(_ file: PickedFile, request: URLRequest) async -> UploadResult {
        do {
            let (body, response) = switch file.source {
            case .file(let url): try await URLSession.shared.upload(for: request, fromFile: url)
            case .data(let data): try await URLSession.shared.upload(for: request, from: data)
            }
            return UploadAPI.result(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: body)
        } catch {
            return .failed(.failed)
        }
    }

    /// A small copy of a picture, for its chip. Files whose names do not say they are pictures are not read.
    static func preview(_ file: PickedFile, localId: String) async -> LoadedImage? {
        await Task.detached {
            switch file.source {
            case .data(let data):
                return LoadedImage(imageId: localId, data: data)
            case .file(let url):
                guard UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true,
                      let data = try? Data(contentsOf: url, options: .mappedIfSafe)
                else { return nil }
                return LoadedImage(imageId: localId, data: data)
            }
        }.value
    }
}
