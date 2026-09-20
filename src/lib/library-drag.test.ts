import { describe, expect, it } from 'vitest';
import { dropDestination } from './library-drag';
import { UNFILED, type TreeDoc } from './library-tree';

const doc = (id: string, title: string, parentId: string | null = null, folder = ''): TreeDoc => ({
	id,
	title,
	folder,
	parentId
});

const docs = [
	doc('epic', 'Epic', null, 'Epics'),
	doc('s1', 'Sprint 1', 'epic', 'Epics'),
	doc('t1', 'Task 1', 's1', 'Epics'),
	doc('loose', 'Loose note')
];

describe('dropping a document', () => {
	it('files it in the folder it was dropped on', () => {
		expect(dropDestination(docs, 'loose', { folder: 'Epics' })).toEqual({ folder: 'Epics' });
	});

	it('reads the Unfiled heading as the empty label the server stores', () => {
		expect(dropDestination(docs, 'epic', { folder: UNFILED })).toEqual({ folder: '' });
	});

	it('nests it under the document it was dropped on', () => {
		expect(dropDestination(docs, 'loose', { docId: 's1' })).toEqual({ parentId: 's1' });
	});

	it('takes a nested document out of its tree when dropped on a folder', () => {
		expect(dropDestination(docs, 's1', { folder: 'Epics' })).toEqual({ folder: 'Epics' });
	});

	it('refuses its own descendants, so a cycle is never on offer', () => {
		// The server refuses this too, but a refusal you can see before letting
		// go beats one that arrives as an error afterwards.
		expect(dropDestination(docs, 'epic', { docId: 't1' })).toBeNull();
		expect(dropDestination(docs, 'epic', { docId: 'epic' })).toBeNull();
	});

	it('refuses a document already too deep to take a child', () => {
		const deep = [
			doc('l1', 'L1'),
			doc('l2', 'L2', 'l1'),
			doc('l3', 'L3', 'l2'),
			doc('l4', 'L4', 'l3'),
			doc('l5', 'L5', 'l4'),
			doc('spare', 'Spare')
		];
		expect(dropDestination(deep, 'spare', { docId: 'l4' })).toEqual({ parentId: 'l4' });
		expect(dropDestination(deep, 'spare', { docId: 'l5' })).toBeNull();
	});

	it('asks for nothing when the drop changes nothing', () => {
		expect(dropDestination(docs, 's1', { docId: 'epic' })).toBeNull();
		expect(dropDestination(docs, 'epic', { folder: 'Epics' })).toBeNull();
		expect(dropDestination(docs, 'loose', { folder: UNFILED })).toBeNull();
	});

	it('asks for nothing when there is nothing under the pointer', () => {
		expect(dropDestination(docs, 'loose', null)).toBeNull();
	});
});
