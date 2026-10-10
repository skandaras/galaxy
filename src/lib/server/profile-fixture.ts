import {
	addEntry,
	addSubdomain,
	createEntity,
	type Domain,
	type EntityKind,
	type Kind
} from './profile';

/**
 * A fictional person's profile at full size: four hundred entries, ten people
 * and things, some pinned, some private, some true only for now.
 *
 * Fiction, so a score against it says retrieval behaves sensibly on a profile
 * shaped the way the design assumes. That is a regression guard, not a claim
 * about anyone's real profile.
 *
 * Built in a fixed order with a clock that ticks once per entry, so the order
 * every reader sorts by is the same on every run.
 */

export const FIXTURE_NOW = new Date('2026-10-10T09:00:00Z');

interface Row {
	path: string;
	claim: string;
	kind?: Kind;
	pinned?: boolean;
	/** Days from FIXTURE_NOW. */
	expires?: number;
	about?: string;
}

const ENTITIES: { kind: EntityKind; name: string; relation: string; aka?: string[] }[] = [
	{ kind: 'person', name: 'Aroha', relation: 'partner', aka: ['Ro'] },
	{ kind: 'person', name: 'Nikau', relation: 'son' },
	{ kind: 'person', name: 'Mere', relation: 'mother' },
	{ kind: 'person', name: 'Hemi', relation: 'brother' },
	{ kind: 'person', name: 'Sam', relation: 'friend' },
	{ kind: 'person', name: 'Priya', relation: 'colleague' },
	{ kind: 'pet', name: 'Pip', relation: 'dog' },
	{ kind: 'organisation', name: 'Acme', relation: 'employer' },
	{ kind: 'project', name: 'Galaxy', relation: 'side project' },
	{ kind: 'place', name: 'Raglan bach', relation: 'holiday house' }
];

const CUSTOM: [Domain, string, ('normal' | 'personal' | 'private')?][] = [
	['work', 'conferences'],
	['life', 'garden'],
	['interests', 'cooking'],
	['interests', 'travel'],
	['interests', 'reading']
];

const each = (path: string, claims: string[], kind: Kind = 'fact'): Row[] =>
	claims.map((claim) => ({ path, claim, kind }));

const ROWS: Row[] = [
	{ path: 'identity/basics', claim: 'Tama; lives in Auckland (NZDT); writes NZ English; uses metric.', pinned: true },
	...each('identity/basics', [
		'Born in 1988.',
		'Uses he/him pronouns.',
		'Speaks English and conversational te reo Māori.',
		'Left-handed, which matters for some tools and desks.',
		'Prefers to be called Tama rather than Tamati.'
	]),
	...each('identity/background', [
		'Grew up in Rotorua beside the lake.',
		'Studied architecture at Victoria University of Wellington.',
		'Worked as an architect for six years before moving into software.',
		'Moved into software in 2016 through a front-end bootcamp.',
		'Lived in Melbourne from 2014 to 2016.',
		'First job was at a petrol station on the Rotorua highway.',
		'Was a competitive swimmer as a teenager.',
		'Spent a gap year working on a dairy farm in Southland.',
		'Has a younger brother and no sisters.',
		'Parents ran a motel in Rotorua for twenty years.',
		'Learnt to code on a borrowed laptop at twenty-six.',
		'Designed two school buildings while an architect.',
		'Was a youth leader at a marae in Rotorua.',
		'Failed first-year calculus and retook it.',
		'Played bass in a covers band during university.'
	]),
	...each('identity/culture', [
		'Māori (Ngāti Whakaue) on his father’s side.',
		'Pākehā on his mother’s side, with Scottish grandparents.',
		'Goes back to the marae for tangihanga and big occasions.',
		'Celebrates Matariki with a family hāngī.',
		'Is learning his whakapapa from his uncle.',
		'Raised with both church and tikanga at home.'
	]),
	{ path: 'work/role', claim: 'Staff engineer leading a five-person platform team.', pinned: true },
	...each('work/role', [
		'Reports to the head of engineering.',
		'Runs the weekly platform review meeting.',
		'Does the on-call rotation one week in six.',
		'Hires for the platform team and sits on interview panels.',
		'Was promoted to staff engineer in March 2025.'
	]),
	...each('work/organisation', [
		'Works at Acme, a 40-person logistics startup in Wellington.',
		'Acme works remotely, with a Wellington office used twice a month.',
		'Acme ships freight-routing software for trucking firms.',
		'Acme raised a Series A in 2025.',
		'Acme’s engineering team is twelve people.',
		'Acme uses Linear for tickets and Notion for documents.',
		'Acme’s working day runs 9 to 5 NZT with no meetings on Fridays.',
		'Acme’s main customers are in New Zealand and Australia.',
		'Has an equity grant at Acme vesting over four years.',
		'Acme pays for one conference trip a year.',
		'Acme’s CTO is a former colleague from Melbourne.',
		'Acme holds an offsite each March.',
		'Acme’s office is on Cuba Street in Wellington.',
		'Acme’s on-call is paid at a flat weekly rate.',
		'Acme gives each engineer a learning budget of 1,500 dollars.'
	]),
	...each('work/expertise', [
		'Deep in TypeScript; writes it every day.',
		'Strong with SQLite and its query planner.',
		'Knows Svelte well and has shipped two apps in it.',
		'Comfortable with PostgreSQL administration.',
		'Uses Docker daily and builds multi-stage images.',
		'Knows Kubernetes basics but avoids running it.',
		'New to Rust; has written one small CLI.',
		'Reads Go comfortably but rarely writes it.',
		'Writes Python for scripts and data clean-up.',
		'Good at system design for small teams.',
		'Cares about web accessibility and knows WCAG well.',
		'Strong with CSS layout, grid and container queries.',
		'Has used GraphQL and prefers plain REST.',
		'Sets up observability with OpenTelemetry.',
		'Has run incident response for production outages.',
		'Reviews code carefully and writes long review notes.',
		'Writes clear technical documentation.',
		'Mentors two junior engineers.',
		'Knows AWS well, especially ECS and RDS.',
		'Writes Terraform for infrastructure.',
		'Administers Linux servers comfortably.',
		'Understands networking basics: DNS, TLS, load balancers.',
		'Does security threat modelling for new services.',
		'Good at relational data modelling.',
		'Profiles performance with flame graphs.'
	]),
	{ path: 'work/tools', claim: 'Uses Neovim, pnpm and Docker on Linux.', kind: 'preference', pinned: true },
	...each(
		'work/tools',
		[
			'Uses a ThinkPad X1 Carbon running Fedora.',
			'Uses tmux with a split-pane layout.',
			'Uses fish as his shell.',
			'Uses Git from the command line, never a GUI.',
			'Uses Postgres 16 at work and SQLite at home.',
			'Uses Vitest for tests and Playwright for browser checks.',
			'Uses GitHub for code and GitHub Actions for CI.',
			'Uses 1Password for secrets.',
			'Uses Obsidian for personal notes.',
			'Uses Excalidraw for diagrams.',
			'Uses a split mechanical keyboard.',
			'Uses a 27-inch monitor in portrait for code.',
			'Uses Firefox as his main browser.',
			'Uses Grafana dashboards for monitoring.',
			'Uses Sentry for error tracking.',
			'Uses Caddy as a reverse proxy at home.',
			'Uses Tailscale to reach home servers.',
			'Uses a Raspberry Pi for home automation.',
			'Uses Figma only to read designs.',
			'Uses Bruno for testing HTTP APIs.',
			'Uses jq for JSON on the command line.',
			'Uses ripgrep instead of grep.',
			'Uses Zod for runtime validation in TypeScript.',
			'Uses Drizzle as his ORM.'
		],
		'preference'
	),
	...each(
		'work/projects',
		[
			'Building Galaxy, a self-hosted AI workspace.',
			'Leading Acme’s migration from Heroku to AWS.',
			'Writing an internal guide to on-call at Acme.',
			'Rebuilding Acme’s route planner API.',
			'Maintains a small open-source SQLite migration tool.',
			'Helping Priya design Acme’s event pipeline.',
			'Building a garden irrigation controller on the Raspberry Pi.',
			'Writing a talk on boring technology for a local meetup.',
			'Planning to open-source Acme’s map tile cache.',
			'Prototyping offline sync for Acme’s driver app.',
			'Cleaning up Acme’s Terraform modules.',
			'Running a reading group on distributed systems at Acme.',
			'Building a family photo archive on a home server.',
			'Translating a children’s book into te reo for Nikau.',
			'Designing a treehouse with Nikau.',
			'Setting up Acme’s first status page.',
			'Writing Galaxy’s install documentation.',
			'Mentoring a bootcamp graduate on weekends.',
			'Planning Acme’s 2027 platform roadmap.',
			'Evaluating Fly.io for Acme’s staging environment.'
		],
		'goal'
	),
	...each('work/conferences', [
		'Spoke at KiwiCon in 2024 about SQLite in production.',
		'Attended Strange Loop in 2023.',
		'Attended Web Directions Summit in Sydney in 2025.',
		'Goes to the Wellington TypeScript meetup monthly.',
		'Ran a workshop on accessibility at Webstock.',
		'Attended JSConf Australia in 2022.',
		'Watches every Systems We Love recording.',
		'Gave a lightning talk at Kiwi PyCon.',
		'Is on the programme committee for a local meetup.',
		'Attended re:Invent once and found it too big.',
		'Wants to speak at Monki Gras.',
		'Attended the SQLite user forum in 2024.',
		'Volunteers at the Wellington DevFest each year.',
		'Gave a talk about on-call to the Auckland DevOps meetup.',
		'Attended Svelte Summit online in 2025.'
	]),
	...each('life/home', [
		'Lives with Aroha and Nikau in a villa in Grey Lynn.',
		'The house has a vegetable garden and a lemon tree.',
		'Rents, with a lease running to March 2027.',
		'Works from a converted sleep-out in the garden.',
		'The house has solar panels and a heat pump.',
		'Has a home server rack in the hallway cupboard.',
		'Neighbours on the left have chickens.',
		'The house is a ten-minute walk to Kowhai School.',
		'Has a small workshop for woodwork in the garage.',
		'Shares a car-share membership with the neighbours.',
		'The fibre connection is 900 Mbps.',
		'Hosts whānau for Christmas most years.'
	]),
	{ path: 'life/home', claim: 'Moving house to Raglan.', kind: 'goal', pinned: true, expires: 22 },
	...each('life/routines', [
		'Does the school run on Tuesdays and Thursdays.',
		'Swims at the Grey Lynn pool before work on Mondays.',
		'Walks Pip twice a day, at 7am and 6pm.',
		'Cooks dinner on weeknights; Aroha cooks at weekends.',
		'Takes Friday afternoons for deep work.',
		'Calls his mother Mere every Sunday evening.',
		'Reads to Nikau at bedtime most nights.',
		'Does the weekly shop on Saturday mornings.',
		'Meditates for ten minutes after lunch.',
		'Goes to bed by 10:30 on work nights.',
		'Reviews the week’s calendar every Sunday night.',
		'Runs the dishwasher overnight on cheap power.',
		'Has a standing Wednesday lunch with Sam.',
		'Waters the garden every second evening in summer.',
		'Does a monthly backup check of the home server.',
		'Plays football with Nikau in the park on Saturday afternoons.',
		'Takes the 7:42 train on office days.',
		'Batch-cooks soup on Sundays.',
		'Plans the week’s meals on Saturday.',
		'Does a longer run every Sunday morning.'
	]),
	...each('life/commitments', [
		'Coaches Nikau’s football team on Saturday mornings.',
		'Is treasurer of the Kowhai School PTA.',
		'Volunteers at the community garden once a month.',
		'Sits on the body corporate committee for his mother’s flat.',
		'Helps run the marae’s website.',
		'Is a trustee for his late grandfather’s land block.',
		'Teaches a coding club at the library once a term.',
		'Is godfather to Sam’s daughter.',
		'Drives Mere to her hospital appointments.',
		'Organises the street’s summer barbecue.',
		'Is on the roster for the school’s Friday sausage sizzle.',
		'Helps his brother Hemi with his tax return each year.',
		'Runs a monthly repair café at the community hall.',
		'Is a referee for under-9 football.',
		'Edits the marae newsletter twice a year.'
	]),
	...each('life/logistics', [
		'No car; cycles or takes the train.',
		'Has an e-bike with a child seat.',
		'Holds a New Zealand passport and an Australian visa.',
		'Prefers aisle seats on long flights.',
		'Flies Air New Zealand and keeps Koru status.',
		'Keeps a packed go-bag for earthquakes.',
		'Uses the Hop card for Auckland transport.',
		'Parcels go to the dairy on the corner.',
		'Has a driver’s licence but rarely drives.',
		'Books holidays around school terms.',
		'Visits Rotorua every school holidays.',
		'Keeps spare house keys with the neighbours.',
		'Keeps a family calendar in a shared Google Calendar.',
		'Has a bike locker at Grey Lynn station.',
		'Uses a courier for documents to Rotorua.',
		'Has an Australian bank account for visits to Hemi.',
		'Prefers morning flights.'
	]),
	{ path: 'life/constraints', claim: 'Vegetarian.', kind: 'constraint', pinned: true },
	...each(
		'life/constraints',
		[
			'Cannot take calls before 9am because of the school run.',
			'Avoids alcohol entirely.',
			'Will not fly more than twice a year for climate reasons.',
			'Cannot travel during the PTA’s end-of-term week.',
			'Keeps evenings after 7pm free of work.',
			'Needs a standing desk because of a back injury.',
			'Avoids caffeine after noon.',
			'Will not use Facebook or Instagram.',
			'Prefers not to work weekends unless on call.'
		],
		'constraint'
	),
	...each(
		'life/health',
		[
			'Coeliac; avoids gluten entirely.',
			'Allergic to penicillin.',
			'Had a back injury in 2021 and does physio exercises.',
			'Wears glasses for distance.',
			'Has mild asthma brought on by cold air.',
			'Takes vitamin D in winter.',
			'Sees a GP in Ponsonby.',
			'Has a knee that swells after long downhill runs.'
		],
		'constraint'
	),
	...each('life/money', [
		'Saving for a house deposit by 2028.',
		'Pays rent of 780 dollars a week.',
		'Contributes 6 percent to KiwiSaver.',
		'Pays the credit card in full on the 20th.',
		'Keeps three months of expenses as an emergency fund.',
		'Gives 2 percent of income to charity.',
		'Has a student loan nearly paid off.',
		'Splits household costs evenly with Aroha.'
	]),
	...each('life/garden', [
		'Grows tomatoes and basil every summer.',
		'Has a lemon tree that fruits in winter.',
		'Keeps a worm farm for kitchen scraps.',
		'Grows feijoas along the back fence.',
		'Has raised beds built from macrocarpa.',
		'Grows kūmara in a sunny corner.',
		'Is fighting a possum that eats the citrus.',
		'Composts in three rotating bins.',
		'Grows herbs in pots by the kitchen.',
		'Saves seeds from heritage beans.',
		'Waters with a rain tank.',
		'Grows strawberries with Nikau.',
		'Has a passionfruit vine on the shed.',
		'Plants garlic on the shortest day.',
		'Uses no pesticides in the garden.'
	]),
	{ path: 'interests/pursuits', claim: 'Trail runs; training for the Tarawera 50 km.', pinned: true },
	{ path: 'interests/pursuits', claim: 'Running the Tarawera 50 km in February.', kind: 'goal', expires: 80 },
	...each('interests/pursuits', [
		'Surfs at Raglan when the swell is small.',
		'Keeps bees at the Raglan bach.',
		'Plays touch rugby on Thursday evenings in summer.',
		'Builds furniture from recycled timber.',
		'Plays bass guitar at home.',
		'Does bouldering at a gym in Kingsland.',
		'Fly-fishes on the Tongariro once a year.',
		'Plays chess online most nights.',
		'Restores old bicycles.',
		'Tramps one Great Walk each summer.',
		'Takes film photographs on an old Pentax.',
		'Sea kayaks around the Hauraki Gulf.',
		'Plays the ukulele with Nikau.',
		'Volunteers on trail maintenance in the Waitākere Ranges.',
		'Swims in the sea year-round.',
		'Plays board games with friends monthly.',
		'Makes his own sourdough.',
		'Does wood carving, learning from his uncle.',
		'Goes stargazing with a small telescope.',
		'Paints watercolours on holiday.',
		'Plays social cricket in summer.',
		'Does yoga twice a week for his back.'
	]),
	...each(
		'interests/taste',
		[
			'Prefers Scandinavian crime fiction.',
			'Likes spare, quiet design.',
			'Listens to Fat Freddy’s Drop.',
			'Listens to a lot of jazz, especially Alice Coltrane.',
			'Likes Studio Ghibli films.',
			'Dislikes horror films.',
			'Likes long-form podcasts about history.',
			'Prefers board games over video games.',
			'Likes mid-century furniture.',
			'Prefers black coffee.',
			'Likes Japanese food best.',
			'Likes the paintings of Colin McCahon.',
			'Prefers paper books to e-readers.',
			'Likes Wes Anderson films.',
			'Listens to Six60 on long drives.',
			'Likes brutalist architecture.',
			'Prefers hiking to beach holidays.',
			'Likes British panel shows.',
			'Likes spicy food.',
			'Prefers linen shirts.',
			'Likes vinyl records and has a small collection.',
			'Likes minimalist apps with no notifications.',
			'Prefers small venues for live music.',
			'Likes Ursula K. Le Guin’s novels.',
			'Likes fermented food like kimchi.'
		],
		'preference'
	),
	...each(
		'interests/learning',
		[
			'Learning to sail.',
			'Learning te reo Māori at evening classes.',
			'Learning Rust through Advent of Code.',
			'Learning to play jazz bass lines.',
			'Learning woodturning.',
			'Learning about urban planning.',
			'Learning to cook Sichuan food.',
			'Learning beekeeping from a local club.',
			'Learning to free dive.',
			'Learning about Polynesian navigation.',
			'Learning watercolour technique online.',
			'Learning sign language with Nikau.'
		],
		'goal'
	),
	...each('interests/cooking', [
		'Cooks dal most weeks.',
		'Makes a good mushroom risotto.',
		'Cooks Japanese curry for Nikau.',
		'Makes his own kimchi.',
		'Bakes gluten-free bread for himself.',
		'Cooks hāngī for big family occasions.',
		'Makes pickles from the garden.',
		'Cooks a vegetarian lasagne on birthdays.',
		'Makes fresh pasta with a machine.',
		'Cooks Sichuan mapo tofu.',
		'Makes feijoa chutney every autumn.',
		'Cooks pancakes on Sunday mornings.',
		'Makes ramen broth from scratch on cold weekends.',
		'Cooks a big pot of chilli for the PTA quiz night.',
		'Makes gluten-free pizza bases.',
		'Cooks mushroom stroganoff.',
		'Makes his grandmother’s scone recipe gluten-free.',
		'Cooks Thai green curry with tofu.',
		'Makes miso soup most mornings.',
		'Smokes vegetables on a small kettle barbecue.'
	]),
	...each('interests/travel', [
		'Has visited Japan three times.',
		'Spent a month in Rarotonga as a child.',
		'Has walked the Abel Tasman track.',
		'Has visited Hawaiʻi to see family.',
		'Wants to visit Patagonia.',
		'Has visited Vietnam with Aroha.',
		'Has been to Scotland to see his grandmother’s village.',
		'Has driven around Tasmania.',
		'Wants to sail around Fiji.',
		'Has visited Copenhagen for a conference.',
		'Has camped on Stewart Island.',
		'Wants to take Nikau to Japan.',
		'Has visited Samoa for a wedding.',
		'Prefers trains to planes in Europe.',
		'Has cycled the Otago Central Rail Trail.',
		'Spent a week in Lisbon in 2019.',
		'Wants to see the northern lights.',
		'Has visited Uluru.'
	]),
	...each('interests/reading', [
		'Read The Overstory and loved it.',
		'Reads one book a month for a book club.',
		'Rereads Earthsea every few years.',
		'Read Designing Data-Intensive Applications twice.',
		'Reads Witi Ihimaera.',
		'Reads the New Zealand Listener weekly.',
		'Read Braiding Sweetgrass this year.',
		'Is working through the Dune series.',
		'Reads Patricia Grace’s short stories.',
		'Read The Mythical Man-Month at university.',
		'Reads a poem a day from an anthology.',
		'Reads Henning Mankell’s Wallander novels.',
		'Read A Pattern Language in architecture school.',
		'Reads Jo Nesbø novels on holiday.',
		'Reads Keri Hulme’s The Bone People every decade.',
		'Reads technical books on a tablet but novels on paper.',
		'Read Thinking in Systems last year.',
		'Reads to Nikau from the Hairy Maclary books.',
		'Reads The Spinoff for news.',
		'Is reading a history of the Waikato wars.'
	])
];

/** Each person's card, and claims about them filed elsewhere. */
const PEOPLE: Record<string, string[]> = {
	Aroha: [
		'Aroha is a GP who works weekend shifts.',
		'Aroha’s birthday is 14 March.',
		'Aroha grew up in Dunedin.',
		'Aroha plays netball on Tuesday nights.',
		'Aroha is training to be a GP educator.',
		'Aroha does not eat seafood.',
		'Aroha and Tama met at university.',
		'Aroha likes surprise weekends away.'
	],
	Nikau: [
		'Nikau was born in 2019 and is at Kōwhai School.',
		'Nikau’s football practice is Wednesday at 4pm.',
		'Nikau has a peanut allergy.',
		'Nikau is learning to read in te reo and English.',
		'Nikau loves dinosaurs and space.',
		'Nikau’s best friend is called Leo.',
		'Nikau has swimming lessons on Fridays.',
		'Nikau’s birthday is 2 June.'
	],
	Mere: [
		'Mere lives in Rotorua in a ground-floor flat.',
		'Mere has type 2 diabetes.',
		'Mere is 71 and still drives.',
		'Mere was a primary school teacher.',
		'Mere likes crosswords and Coronation Street.',
		'Mere visits Auckland at Christmas.'
	],
	Hemi: [
		'Hemi lives in Brisbane and works as an electrician.',
		'Hemi has two daughters.',
		'Hemi supports the Chiefs.',
		'Hemi is visiting in December.',
		'Hemi and Tama talk every second Sunday.'
	],
	Sam: [
		'Sam is a friend from university.',
		'Sam works as a landscape architect.',
		'Sam has a daughter called Ana.',
		'Sam is vegan.',
		'Sam lives in Kingsland.'
	],
	Priya: [
		'Priya is a senior engineer at Acme.',
		'Priya leads Acme’s data team.',
		'Priya prefers written proposals to meetings.',
		'Priya is based in Christchurch.',
		'Priya is on parental leave until January.'
	],
	Pip: [
		'Pip is a heading dog who needs two walks a day.',
		'Pip is scared of thunder.',
		'Pip is six years old.',
		'Pip goes to a dog walker on office days.',
		'Pip eats a grain-free diet.'
	]
};

/** Claims filed by subject but about someone in particular. */
const ABOUT: [string, string][] = [
	['life/routines', 'Does the school run on Tuesdays and Thursdays.'],
	['life/routines', 'Calls his mother Mere every Sunday evening.'],
	['life/routines', 'Walks Pip twice a day, at 7am and 6pm.'],
	['work/organisation', 'Works at Acme, a 40-person logistics startup in Wellington.'],
	['work/projects', 'Building Galaxy, a self-hosted AI workspace.'],
	['interests/pursuits', 'Keeps bees at the Raglan bach.']
];
const ABOUT_WHO: Record<string, string> = {
	'Does the school run on Tuesdays and Thursdays.': 'Nikau',
	'Calls his mother Mere every Sunday evening.': 'Mere',
	'Walks Pip twice a day, at 7am and 6pm.': 'Pip',
	'Works at Acme, a 40-person logistics startup in Wellington.': 'Acme',
	'Building Galaxy, a self-hosted AI workspace.': 'Galaxy',
	'Keeps bees at the Raglan bach.': 'Raglan bach'
};

/** Builds the profile for `userId` and returns every claim's id. */
export function seedFixtureProfile(userId: string): Map<string, string> {
	const ids = new Map<string, string>();
	let tick = 0;
	const at = () => new Date(FIXTURE_NOW.getTime() - 400_000 + tick++ * 1000);

	const entities = new Map<string, string>();
	for (const e of ENTITIES) entities.set(e.name, createEntity(userId, e, at()).id);
	for (const [domain, name, sensitivity] of CUSTOM) addSubdomain(userId, domain, name, sensitivity, at());

	const aboutSet = new Set(ABOUT.map(([, c]) => c));
	for (const row of ROWS) {
		const [domain, subdomain] = row.path.split('/') as [Domain, string];
		const now = at();
		const { entry } = addEntry(
			userId,
			{
				domain,
				subdomain,
				kind: row.kind ?? 'fact',
				claim: row.claim,
				pinned: row.pinned,
				about: aboutSet.has(row.claim) ? entities.get(ABOUT_WHO[row.claim]) : null,
				expiresAt: row.expires ? new Date(FIXTURE_NOW.getTime() + row.expires * 86_400_000) : null
			},
			{ source: 'survey', now }
		);
		ids.set(row.claim, entry.id);
	}
	for (const [name, claims] of Object.entries(PEOPLE)) {
		for (const claim of claims) {
			const { entry } = addEntry(
				userId,
				{ domain: 'people', subdomain: entities.get(name)!, kind: 'fact', claim },
				{ source: 'survey', now: at() }
			);
			ids.set(claim, entry.id);
		}
	}
	return ids;
}

export interface EvalQuery {
	/**
	 * `direct`: the words are in the claim. `buried`: one fact among hundreds,
	 * asked about the way an agent would. `absent`: nothing in the profile
	 * answers it, and the right result is nothing.
	 */
	kind: 'direct' | 'buried' | 'absent';
	query: string;
	/** Claims, exactly as written above, that should come back. */
	expect: string[];
}

export const EVAL_QUERIES: EvalQuery[] = [
	{ kind: 'direct', query: 'vegetarian', expect: ['Vegetarian.'] },
	{
		kind: 'direct',
		query: 'gluten coeliac',
		expect: [
			'Coeliac; avoids gluten entirely.',
			'Bakes gluten-free bread for himself.',
			'Makes gluten-free pizza bases.',
			'Makes his grandmother’s scone recipe gluten-free.'
		]
	},
	{ kind: 'direct', query: 'Neovim editor', expect: ['Uses Neovim, pnpm and Docker on Linux.'] },
	{ kind: 'direct', query: 'Rust', expect: ['New to Rust; has written one small CLI.', 'Learning Rust through Advent of Code.'] },
	{ kind: 'direct', query: 'Tarawera', expect: ['Trail runs; training for the Tarawera 50 km.', 'Running the Tarawera 50 km in February.'] },
	{ kind: 'direct', query: 'Acme employer startup', expect: ['Works at Acme, a 40-person logistics startup in Wellington.'] },
	{ kind: 'direct', query: 'sailing', expect: ['Learning to sail.'] },
	{ kind: 'direct', query: 'KiwiSaver', expect: ['Contributes 6 percent to KiwiSaver.'] },
	{ kind: 'direct', query: 'Raglan', expect: ['Moving house to Raglan.', 'Keeps bees at the Raglan bach.', 'Surfs at Raglan when the swell is small.'] },
	{ kind: 'direct', query: 'Postgres database', expect: ['Uses Postgres 16 at work and SQLite at home.', 'Comfortable with PostgreSQL administration.'] },
	{ kind: 'direct', query: 'te reo', expect: ['Learning te reo Māori at evening classes.', 'Speaks English and conversational te reo Māori.'] },
	{ kind: 'buried', query: 'penicillin antibiotics allergy', expect: ['Allergic to penicillin.'] },
	{ kind: 'buried', query: 'Aroha birthday', expect: ['Aroha’s birthday is 14 March.'] },
	{ kind: 'buried', query: 'football practice', expect: ['Nikau’s football practice is Wednesday at 4pm.'] },
	{ kind: 'buried', query: 'flight seat', expect: ['Prefers aisle seats on long flights.'] },
	{ kind: 'buried', query: 'credit card payment date', expect: ['Pays the credit card in full on the 20th.'] },
	{ kind: 'buried', query: 'bees beekeeping', expect: ['Keeps bees at the Raglan bach.', 'Learning beekeeping from a local club.'] },
	{ kind: 'buried', query: 'car drive commute', expect: ['No car; cycles or takes the train.'] },
	{ kind: 'buried', query: 'peanut allergy', expect: ['Nikau has a peanut allergy.'] },
	{ kind: 'buried', query: 'thunder scared dog', expect: ['Pip is scared of thunder.'] },
	{ kind: 'buried', query: 'diabetes mother', expect: ['Mere has type 2 diabetes.'] },
	{ kind: 'buried', query: 'parental leave', expect: ['Priya is on parental leave until January.'] },
	{ kind: 'buried', query: 'calls before 9am', expect: ['Cannot take calls before 9am because of the school run.'] },
	{ kind: 'buried', query: 'back injury desk', expect: ['Needs a standing desk because of a back injury.', 'Had a back injury in 2021 and does physio exercises.'] },
	{ kind: 'buried', query: 'Ro netball', expect: ['Aroha plays netball on Tuesday nights.'] },
	{ kind: 'buried', query: 'lease rent', expect: ['Rents, with a lease running to March 2027.', 'Pays rent of 780 dollars a week.'] },
	{ kind: 'absent', query: 'cryptocurrency trading', expect: [] },
	{ kind: 'absent', query: 'skiing snowboard', expect: [] },
	{ kind: 'absent', query: 'piano lessons', expect: [] },
	{ kind: 'absent', query: 'golf handicap', expect: [] },
	{ kind: 'absent', query: 'Tesla electric vehicle', expect: [] },
	{ kind: 'absent', query: 'divorce lawyer', expect: [] }
];
