import type { AppEvent } from '../core/events.ts';
import type { ImageProps, StatusProps } from '../core/props.ts';

/** What the view's components share: the way events go up, and the small pieces more than one screen draws. */

export type Dispatch = (event: AppEvent) => void;

export function Status({ status }: { status: StatusProps }) {
  return <p class={`status ${status.tone}`} role="status">{status.text}</p>;
}

export function Images({ images }: { images: ImageProps[] }) {
  return (
    <div class="images">
      {images.map(image => (
        <a key={image.src} href={image.src} target="_blank" rel="noopener">
          <img src={image.src} alt={image.alt} title={image.alt} loading="lazy"
            {...(image.width && image.height ? { width: image.width, height: image.height } : {})}
            // A picture that cannot be fetched says so in its place; the text stays (the contract's 会話の画像).
            onError={event => event.currentTarget.classList.add('broken')} />
        </a>
      ))}
    </div>
  );
}

