/**
 * Copy text to the clipboard.
 *
 * The async Clipboard API only exists in secure contexts, and Galaxy is often
 * self-hosted on plain HTTP over a LAN, so the legacy path is a real fallback
 * rather than dead code.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (window.isSecureContext && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission denied or a non-focused document — try the old way.
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	// Keep it off-screen but still focusable, which execCommand requires.
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.top = '-1000px';
	area.style.opacity = '0';
	document.body.appendChild(area);
	try {
		area.select();
		area.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		document.body.removeChild(area);
	}
}
