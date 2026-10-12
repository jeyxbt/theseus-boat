/** The four house rules, shown on the home page and on /rules. */
export const HOUSE_RULES = [
	{ title: 'Be kind.', text: 'Ideas that target people are filtered out before voting.' },
	{ title: 'Nothing from outside.', text: 'No trackers, ads or third-party scripts. Ever.' },
	{ title: 'Small steps.', text: 'One idea per build, so every change is easy to read.' },
	{ title: 'The core stays put.', text: 'Voting and sign-in can’t be rewritten by an idea.' },
];

/** How a change happens, step by step. */
export const HOW_IT_WORKS = [
	{
		title: 'Propose',
		text: 'One idea per person per window. Up to 280 characters. Make it something you’d want to see tomorrow.',
		icon: 'pencil',
	},
	{
		title: 'Vote',
		text: 'Three free votes each window. Sign in with X, Google or GitHub — one person, one voice.',
		icon: 'thumb-up',
	},
	{
		title: 'AI builds it',
		text: 'The winner is written, checked and deployed automatically. If anything breaks, the site rolls itself back.',
		icon: 'code',
	},
	{
		title: 'Public forever',
		text: 'Every change is a commit, credited to the idea that started it. Anyone can read every line.',
		icon: 'git-branch',
	},
];
