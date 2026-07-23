export interface SessionUser {
	id: string;
	username: string;
	email: string | null;
	displayName: string | null;
	isAdmin: boolean;
}

export interface AuthHeaders {
	username: string;
	email: string | null;
	displayName: string | null;
	groups: string[];
}

/**
 * True when `ip` matches one of `trusted` (exact IP or IPv4 CIDR).
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are normalised first.
 */
export function isTrustedProxy(ip: string, trusted: string[]): boolean {
	const addr = normaliseIp(ip);
	return trusted.some((entry) => {
		const t = entry.trim();
		if (!t) return false;
		if (!t.includes('/')) return normaliseIp(t) === addr;
		return ipv4InCidr(addr, t);
	});
}

function normaliseIp(ip: string): string {
	const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	return v4mapped ? v4mapped[1] : ip;
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const p of parts) {
		const b = Number(p);
		if (!Number.isInteger(b) || b < 0 || b > 255) return null;
		n = n * 256 + b;
	}
	return n;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
	const [base, bitsStr] = cidr.split('/');
	const bits = Number(bitsStr);
	const ipInt = ipv4ToInt(ip);
	const baseInt = ipv4ToInt(base);
	if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
		return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/**
 * Extract identity from Authelia forward-auth headers.
 * Returns null when no usable identity is present.
 */
export function parseAuthHeaders(get: (name: string) => string | null): AuthHeaders | null {
	const username = get('remote-user')?.trim();
	if (!username) return null;
	const groups = (get('remote-groups') ?? '')
		.split(',')
		.map((g) => g.trim())
		.filter(Boolean);
	return {
		username,
		email: get('remote-email')?.trim() || null,
		displayName: get('remote-name')?.trim() || null,
		groups
	};
}

export function isAdminFromGroups(groups: string[], adminGroup: string): boolean {
	return groups.includes(adminGroup);
}
