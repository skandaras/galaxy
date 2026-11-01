import { mount, unmount } from 'svelte';
import ImagePreview from './components/ImagePreview.svelte';

/** Enhance sanitised markdown images, including ones arriving during streaming. */
export function imagePreviews(node: HTMLElement) {
	const mounted = new Map<HTMLElement, ReturnType<typeof mount>>();
	function update() {
		for (const [host, component] of mounted) {
			if (!node.contains(host)) {
				void unmount(component).catch(() => {});
				mounted.delete(host);
			}
		}
		for (const image of node.querySelectorAll<HTMLImageElement>('img')) {
			if (image.closest('.image-preview')) continue;
			const host = document.createElement('span');
			// A markdown image may itself be linked. Its controls need their own
			// click targets rather than buttons nested inside that link.
			const parent = image.parentElement;
			const target = parent?.tagName === 'A' && parent.childNodes.length === 1 ? parent : image;
			target.replaceWith(host);
			mounted.set(host, mount(ImagePreview, {
				target: host, props: { src: image.src, alt: image.alt }
			}));
		}
	}
	const observer = new MutationObserver(update);
	observer.observe(node, { childList: true, subtree: true });
	update();
	return { destroy() {
		observer.disconnect();
		for (const component of mounted.values()) void unmount(component).catch(() => {});
		mounted.clear();
	} };
}
