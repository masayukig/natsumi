import NatsumiCore
import SwiftUI

/// The files for the next message, as chips in a row over the input field: a picture small, any other file by its
/// mark, each with its name, how it is going, and a × to take it away (ADR 0071).
struct AttachmentChipsView: View {
    let chips: [AttachmentChipProps]
    let remove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    AttachmentChipView(props: chip) { remove(chip.localId) }
                }
            }
        }
    }
}

private struct AttachmentChipView: View {
    let props: AttachmentChipProps
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                if let thumbnail = props.thumbnail {
                    Image(decorative: thumbnail.thumbnail, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFill()
                } else {
                    Color.gray.opacity(0.15)
                    Image(systemName: props.isFailed ? "exclamationmark.triangle" : "doc")
                        .foregroundStyle(props.isFailed ? Color.red : Color.secondary)
                }
                if props.isUploading {
                    Color.black.opacity(0.2)
                    ProgressView().controlSize(.small)
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 1) {
                Text(props.name).font(.caption).lineLimit(1).truncationMode(.middle)
                Text(props.detail).font(.caption2).lineLimit(2)
                    .foregroundStyle(props.isFailed ? Color.red : Color.secondary)
            }
            .frame(maxWidth: 160, alignment: .leading)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(props.removeLabel)
                .accessibilityLabel(props.removeLabel)
        }
        .padding(4)
        .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(props.isFailed ? Color.red.opacity(0.6) : Color.gray.opacity(0.3)))
        .accessibilityElement(children: .contain)
    }
}

/// The files the owner attached to a message that are not pictures, one line each: the mark, the name and the size.
struct AttachedFilesView: View {
    let files: [AttachedFileProps]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(files) { file in
                HStack(spacing: 4) {
                    Image(systemName: "doc")
                    Text(file.name).lineLimit(1).truncationMode(.middle)
                    Text(file.detail).foregroundStyle(.secondary)
                }
                .font(.caption)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// The names of the files that go with a message the server has not taken yet.
struct OutgoingFilesView: View {
    let names: [String]

    var body: some View {
        if !names.isEmpty {
            VStack(alignment: .trailing, spacing: 1) {
                ForEach(Array(names.enumerated()), id: \.offset) { _, name in
                    Label(name, systemImage: "paperclip").font(.caption2).lineLimit(1).truncationMode(.middle)
                }
            }
            .foregroundStyle(.secondary)
        }
    }
}
