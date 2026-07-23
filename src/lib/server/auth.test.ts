import { describe, it, expect } from 'vitest';
import { isTrustedProxy, parseAuthHeaders, isAdminFromGroups } from './auth';

describe('isTrustedProxy', () => {
	it('matches exact IPv4', () => {
		expect(isTrustedProxy('10.0.0.5', ['10.0.0.5'])).toBe(true);
		expect(isTrustedProxy('10.0.0.6', ['10.0.0.5'])).toBe(false);
	});

	it('matches IPv4 CIDR ranges', () => {
		expect(isTrustedProxy('172.18.0.9', ['172.18.0.0/16'])).toBe(true);
		expect(isTrustedProxy('172.19.0.9', ['172.18.0.0/16'])).toBe(false);
		expect(isTrustedProxy('192.168.1.1', ['0.0.0.0/0'])).toBe(true);
	});

	it('normalises IPv4-mapped IPv6 addresses', () => {
		expect(isTrustedProxy('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
		expect(isTrustedProxy('::ffff:172.18.0.2', ['172.18.0.0/16'])).toBe(true);
	});

	it('matches exact IPv6', () => {
		expect(isTrustedProxy('::1', ['127.0.0.1', '::1'])).toBe(true);
	});

	it('rejects malformed entries instead of matching', () => {
		expect(isTrustedProxy('10.0.0.5', ['not-an-ip'])).toBe(false);
		expect(isTrustedProxy('10.0.0.5', ['10.0.0.0/99'])).toBe(false);
		expect(isTrustedProxy('10.0.0.5', [''])).toBe(false);
	});
});

describe('parseAuthHeaders', () => {
	const headers = (map: Record<string, string>) => (name: string) => map[name] ?? null;

	it('extracts identity from Authelia headers', () => {
		const auth = parseAuthHeaders(
			headers({
				'remote-user': 'skandaras',
				'remote-email': 'skandaras@gmail.com',
				'remote-name': 'Skandaras',
				'remote-groups': 'galaxy-admins, users'
			})
		);
		expect(auth).toEqual({
			username: 'skandaras',
			email: 'skandaras@gmail.com',
			displayName: 'Skandaras',
			groups: ['galaxy-admins', 'users']
		});
	});

	it('returns null without a username', () => {
		expect(parseAuthHeaders(headers({}))).toBeNull();
		expect(parseAuthHeaders(headers({ 'remote-user': '  ' }))).toBeNull();
	});

	it('handles missing optional headers', () => {
		const auth = parseAuthHeaders(headers({ 'remote-user': 'sk' }));
		expect(auth).toEqual({ username: 'sk', email: null, displayName: null, groups: [] });
	});
});

describe('isAdminFromGroups', () => {
	it('grants admin only via the configured group', () => {
		expect(isAdminFromGroups(['galaxy-admins'], 'galaxy-admins')).toBe(true);
		expect(isAdminFromGroups(['users'], 'galaxy-admins')).toBe(false);
		expect(isAdminFromGroups([], 'galaxy-admins')).toBe(false);
	});
});
