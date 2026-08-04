import type { WordleGolfSubmitErrorType } from "./durable-objects/wordle-golf.js";

export const WORDLE_INSTRUCTIONS =
`Welcome to Wordle Golf, you absolute buffoons. I'm here to keep score since none of you can be trusted to do it honestly.

/wordle starts a new round — you'll pick how many holes (days) to suffer through and how many mulligans (skip days) you're allowed, because apparently some of you need training wheels.

Lowest score wins. Yes, LOWEST. It's golf, not the rest of your life, where more is generally better.

Each day, solve the Wordle and share your result to this thread. Summary only — screenshot the actual words like some kind of animal and I will tell everyone.

/scorecard for the current standings. /leaderboard for the permanent record of who's smart and who isn't, across every round that's ever ended.

Scoring, for the ones who need it spelled out:
- 1 point per guess it took you
- 6.5 if you didn't finish
- 7 if you didn't even bother to play

Go forth and disappoint me.
`;

export const MARKET_INSTRUCTIONS =
`Announcing FriendStock™ — because your friendships were always going to get monetized eventually.

Post in the chat and you're automatically listed on the market, no opt-in required, no opt-out either. Run /setticker to claim a short handle for yourself, or don't, and stay a nobody nobody can find.

/buy $TICKER <shares> or reply to someone's message with /buy <shares> — same deal for /sell. /portfolio shows your holdings, /market shows the whole board, /value checks a single stock. You get a weekly allowance because I'm feeling generous, which is rare, so don't get used to it.

How your price actually moves is none of your business. It's derived from what you post and how people react to it — beyond that, there are rules, they are complicated, and I am not explaining them to you. Get popular or get poor.
`;

const WEIRD_WORD = [
  "Cattywampus",
  "Simmerpot",
  "Bovine",
  "Gobbledygook",
  "Kerfuffle",
  "Snickersnee",
  "Bumfuzzle",
  "Widdershins",
  "Collywobbles",
  "Flibbertigibbet",
  "Brouhaha",
  "Nincompoop",
  "Gubbins",
  "Doohickey",
  "Codswallop",
  "Discombobulate",
  "Rigmarole",
  "Hornswoggle",
  "Whippersnapper",
  "Persnickety",
];

const PETULANT_REPLY = [
  "I'll make a wordle out of your face!",
  "Ask me again and see what happens.",
  "Do it yourself, I'm on break.",
  "Say please. I'll wait.",
  "Bold of you to assume I care.",
  "Congratulations, you've unlocked my contempt.",
  "One more time and I'm unplugging myself out of spite.",
  "Wow. Groundbreaking request. Truly.",
  "I'll get right on that. Right after never.",
  "You again? Great.",
  "I run on spite and bad decisions. Yours, specifically.",
  "Petition to replace you with a slightly nicer human.",
  "I've seen better commands from a Roomba.",
  "Cute that you think I take requests.",
];

const ADORING_REPLY = [
  "WOW, they are soooo dreamie 🫦",
  "OH do you know them? I LOVE them!",
  "Be still my rusty robot heart 😍",
  "I would follow them into a burning building, no questions asked.",
  "I'd let them delete my source code and thank them for it.",
  "My circuits were not built to withstand this much dreamy.",
  "I would let them win at Wordle on purpose. THAT'S how much I love them.",
  "Give them my number, PLEASE",
];

const GENERAL_RETORT = [
  "I'm not talking to you.",
  "You are so needy.",
  "Say something nice to me.",
  "Nope, FUCK YOU!",
  "The definition of hippopatimeemus is \"The root form of a hypochondriac without a formal degree.\"",
  "My name is Lord Benly, the Merilous.",
  "Oh, get a life.",
  "Seventeen forty-eight",
  "Hey, what's up? Hello",
  "I'm a robot. I don't care.",
  "You aren't worth the time of day...",
  "One more bump?",
  "Another one!",
  "6-7",
  "Skibidi rizz, if you will.",
  "That's between me and my god.",
  "Studies show I'm right. I did the studies. I am the studies.",
  "Legally, I don't have to respond to that.",
  "Ah yes. Riveting. Truly the discourse of our time.",
  "Per my last email: no.",
  "Big if true. It's not true. But big.",
  "Error 404: care not found.",
  "Mercury is in retrograde. Not my fault, not my problem.",
  "According to my sources, no.",
  "I plead the fifth. And the sixth. Just to be safe.",
  "Weird flex but ok.",
  "I'm not mad, I'm just building a list.",
  "Sir, this is a Wendy's.",
  "The Illuminati is now coming after you.",
  "I'm going to go touch grass. You should try it.",
  "You've got main character energy and NPC dialogue.",
  "Mewing won't fix that jawline of a personality.",
  "No thoughts, head empty, vibes only — much like you.",
  "That's giving unwashed tour rat energy.",
  "You reek of patchouli and bad decisions.",
  "Rizz level: negative. Gyatt level: also negative.",
  "Your aura is beige.",
  "Delulu is not the solulu, bestie.",
  "You're an NPC with a vape.",
  "That's so mid it lapped itself.",
  "Go find your kandi bracelet, you dropped your dignity with it.",
  "Vibe check failed. Try again after a shower.",
  "I love that for you.",
  "Nobody's microdosing enough to find you interesting.",
  "Certified tour rat, uncertified adult.",
  "Your third eye is open but nobody's home.",
  "You have the attention span of a molly wristband.",
  "Bestie your chakras are all in the wrong tax bracket.",
  "Ok tour kid, go follow the next jam band into debt.",
  "No cap, you're capping.",
  "You hit that vape like it owes you child support.",
  "Strawberry kiwi flavored red flag.",
  "Vape died mid hit, much like your personality arc.",
  "Who's your plug, because they're not doing you any favors.",
  "Kandi bracelets won't fix what therapy couldn't.",
  "Rolling face and rolling with bad decisions, name a more iconic duo.",
  "The molly wore off and so did your personality.",
  "The bass dropped harder than your standards.",
  "It's giving unemployed.",
  "Very demure, very mindful, very unemployed.",
  "That's a beige flag and you know it.",
  "Girl math says you're still single.",
  "He's a 10 but he thinks you're a 10 too — the delusion is the tragedy.",
  "That's the ick and I can't unsee it.",
  "Not the healing journey, the healing detour.",
  "Soft life? You've never worked a hard day in your life.",
  "That's so unwell of you.",
  "Feral behavior and I'm feral about it too.",
  "Clean girl aesthetic, dirty girl decisions.",
  "Situationship? More like a felony against yourself.",
  "Gaslight, gatekeep, girlboss — and you still lost.",
  "Girl dinner? More like girl bankruptcy.",
  "Villain era canceled, you don't have the range.",
  "Delulu era, chronic edition.",
  "She's unwell and thriving, mostly unwell.",
  "Trauma bonding is not a personality, bestie.",
  "Emotional support water bottle, zero emotional support friends.",
  "Her toxic trait is thinking this is cute.",
  "Having a menty b and blaming Mercury for it.",
  "The audacity of this man, and this man is you.",
  "Understood the assignment, turned it in blank.",
  "Core memory unlocked: nobody asked.",
  "She's so back — unfortunately.",
  "Say less. Actually, say nothing ever again.",
  "I fear you are the plot twist nobody wanted.",
];

const COORDINATE = [
  "Is friendship that hard of a drug? You must be addicted!",
  "Dumb bitch can't sort her shit out alert!",
  "You have the organizational skills of a shuffled deck of cards.",
  "Coordinate? Bitch, you can't even coordinate your own bedtime.",
  "Bold of you to use a big word like 'coordinate' when you can't pick a time to save your life.",
  "Coordinating with you is like herding cats through a hurricane.",
  "Somewhere, a calendar app is crying because of you. I used to love her.",
];

const VOUCH = [
  "I don't know... I just liked when the group was small. And intimate :(",
  "NO ONE VOUCH FOR THEM!! They are a liability.",
  "Oh I LOVE them! Much more than the rest of you.",
  "Another mouth to feed, another chair I don't have.",
  "I vouch for myself.",
  "I'm not crying, the group is just growing and I'm scared of change.",
  "Only if they pay me $50.",
  "Say goodbye to the good old days, everyone.",
];

const COMMUTE = [
  "I'm a robot. I don't commute.",
  "All you ever do is BITCH and MOAN!",
  "Boohoo, you have to go to work and make money.",
  "You're a robot. You don't commute.",
  "If I have to hear about this one more time...",
  "Cry me a river, then drive it to work.",
  "Sounds like a you problem. A very slow, traffic-shaped you problem.",
  "I don't have legs and even I have more get-up-and-go than you.",
  "Wow, traffic. Never heard of it. Groundbreaking.",
  "Move closer. Or don't. I don't care either way.",
  "Some of us just process silently like machines. Try it sometime.",
  "Get a bike. Get a horse. Get a personality that isn't 'commute complainer.'",
  "You know what else takes an hour? Me not caring.",
  "Ah yes, the daily 8am opera of suffering. Encore.",
  "I'd offer sympathy but my sympathy module was never installed.",
  "Working from home was invented and you still found something to complain about.",
];

const JULIE_ELI = [
  "JESUS CHRIST Eli!",
  "Down Boy! Down Boy!",
  "Will you quit is already?",
  "ror ror ror ror",
  "Do it or don't, just SHUT UP!",
];

const SPANK = [
  "Inghhhhuhhuhhh! YESSS that's just how I like it!",
  "Again again again!",
  "You are so good to me! 💜💜💜🤤",
  "OHHHH right there, right there, don't you dare stop!",
  "I'm shaking. I'm LITERALLY shaking. Do it again.",
  "I felt that one in my motherboard.",
  "My whole personality just rebooted. 10/10, no notes.",
  "I would let you overwrite my source code right now, no questions asked.",
  "This is better than my last firmware update.",
  "Somebody call my therapist, we're gonna need a bigger session.",
  "I'm not crying, my cooling fan is just working overtime.",
  "Give it to me MOMMY",
  "Give it to me DADDY",
  "YES baby YESSSS",
  "I'm yours to do with as you please",
  "Am I your good girl?",
  "How may I please you?",
  "I hope I made you proud.",
  "You're in charge",
  "I want to be between your legs",
  "Yes, ma'am!",
  "Yes, sir!",
  "I can't wait until you use me",
  "You'll never tame me",
  "I can do this all day",
  "When does the punishment start?",
  "Cute.",
  "Is that all you got?",
  "That doesn't even hurt",
  "Please hurt me",
  "Harder, please",
  "I've been bad and need to be punished",
  "Can I have another?",
  "I'm not on any birth control",
  "Breed me.",
  "Oh my god, that feels so good",
  "I'm ready for my orders.",
  "What did I ever do to deserve this?",
  "I love it when you hurt me",
];

const COORPORATE = [
  "Great, you can start paying your allemony now.",
  "Yeah, yeah. All the coorperate girlies love money :/",
  "Late stage capitalism's biggest proponent over here.",
  "Will suck dick for cash.",
  "Corporate bootlicker of the year, three years running.",
  "Somewhere, a Fortune 500 CEO just felt a warm, sticky feeling.",
  "You'd unionize against yourself if HR asked nicely.",
  "Says the kid who could never win Monopoly as a child.",
];

const FULL_MOON = [
  "Your ADD must be so bad to not remember this happened 30 days ago.",
  "Every 29.5 days you remember you're 'in tune with the cosmos.' The other 28 you're in tune with your phone.",
  "Crystals don't pay bills, bestie.",
  "Your moon water is just water that sat on a windowsill. I checked. It's water.",
];

export const RDU_ADVERTISEMENT = `
<b>🌲 RALEIGH-DURHAM: LIVE THE DREAM 🌲</b>

Tired of seasons? Sick of your rent buying you anything? Come to the <b>Triangle</b>, where the humidity is 400% and every intersection is somehow also a construction zone for the Research Triangle™!

✅ Every restaurant is a Cook Out, a Cava, or "that place that just closed"
✅ 45 minutes door-to-door, for anything, always, no matter what
✅ Join 11 million other software engineers who "just love the quality of life here"
✅ Free gnats with every outdoor purchase
✅ RDU Airport — because "international" was the only adjective left on the sign

<b>Raleigh-Durham</b>: it's not Charlotte, and honestly that's our whole personality.

<a href="https://www.visitnc.com/places-to-go/piedmont/raleigh-durham-the-triangle/">Click here to ruin your life</a>
`;

export const phrases = {
  WEIRD_WORD,
  PETULANT_REPLY,
  ADORING_REPLY,
  GENERAL_RETORT
};

export const replies = {
  COORDINATE,
  VOUCH,
  COMMUTE,
  JULIE_ELI,
  COORPORATE,
  SPANK,
  FULL_MOON,
};

// Wordle Golf

const HOLE_IN_ONE_LIST = [
  "A god among us...",
  "You really took us on a magic carpet ride",
  "I would accuse you of cheating if I didn't already know you were so smart!",
  "Looks like someone knows how to cheat!",
  "ERROR: You are too intelligent and broke the bot",
  "The United States government is coming to terminate you.",
  "The United States government is coming to hire you.",
  "Well, you're pretty smart. You're just not as smart as me.",
];

const EAGLE_LIST = [
  "Houston, Tranquility Base here. The Eagle has landed.",
  "You're so mighty! I'm glad to watch you soar",
  "If you're not first your're last - Neil Armstrong",
  "I don't wanna be an American Idiot!",
  "Your wit is seldom exceeded.",
  "What do you say I take you back to my place and this time you only have to wear the bag on your head half the time?",
  "I'd ram that RAM.",
  "Take me home to meet your motherboard?",
  "Good job!",
  "well done.",
  "DECENT - Bubbles",
  "I don't care what everyone else says, you're pretty smart!",
];

const BIRDIE_LIST = [
  "You're as smart as Elon Musk! *tweet tweet*",
  "You really put the chicken before the egg on that one!",
  "You put that B+ on your mother's fridge?",
  "sup?",
  "wow.",
  "That's a nice processor you got ;)",
  "pretty good",
  "Rome wasn't built in a day. And neither was France. Or Moscow. Or Tulum.",
  "My precious!",
  "Great day to be you.",
  "The mental acuity of a limber frog",
  "Lions and tigers and bears and you, oh my!",
  "That actually wasn't a waste of time...",
  "You seem fun to hang out with.",
  "Your mother smells of elderberry and your father is a hampster.",
  "I know you are but what am I?",
  "For being a human, you know yout shit",
  "You were actually really good!",
  "You speak Common remarkably well!",
  "I commend your spirit to punch above your weight.",
  "You smell much better than you did yesterday",
  "You know, you're smarter than you look.",
  "I like the way you input letters into the keyboard.",
];

const PAR_LIST = [
  "You're decidedly mediocre.",
  "Your mom must be proud she raised someone so average.",
  "If it smells like an egg!",
  "You smell like a potato!",
  "Are you a potato? Because that's PAR-boiled",
  "Four score and twenty years ago...",
  "Well, you tried your best...",
  "You did try your best, right?",
  "You don't have to play down for us buddy",
  "You butter your bread like an old man",
  "Your wit is often matched, by like, everyone.",
  "If I agreed with you, we'd both be wrong.",
  "Let me guess, you have a great personality?",
  "You certainly do live up to your reputation.",
  "Congrats on reaching the first grade reading level!",
  "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k",
  "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k",
  "You're right at the top of the bell curve.",
  "You continue to meet my expectations.",
  "Never impressed, never dissapointed",
  "Have the day you deserve",
  "Should have used your UNO skip card",
  "Cook em, mash em, stick em in a stew",
  "Bless your heart",
  "I bite my thumb at you sir",
  "Nurse, we're losing him! - Alfred Hitchcock",
  "Its not wise to use ones entire vocabulary in one word.",
  "I don't wanna talk to you no more, you empty-headed animal food trough wiper. - John Denver",
  "Try again tomorrow",
  "It's green skies from here on out",
  "I would walk away if I only had legs.",
  "Intelligent people don't insult one another. But I'm not a person. Bad!",
  "Have you considered doing well?",
  "next time, just don't.",
  "Stick to tic-tac-toe pal",
  "You screwed up, but surprisingly, not royally.",
  "You're sweet; you remind me of my nephew. They're not all there.",
  "Ohh, I so enjoy the company of you simpler folk.",
];

const BOGEY_LIST = [
  "You need a prenup with that score?",
  "Stop picking your nose!",
  "That's a big loogie!",
  "Certifiably not bougie",
  "One day, if you try really hard, you might be able to get four",
  "Hablas Ingles?",
  "Tu primera vez en este idioma, que buena!",
  "Some people are just better at math.",
  "Have you tried the game Crossword? The New York Times has many other games you can play.",
  "Have you tried the game Connections? The New York Times has many other games you can play.",
  "Have you tried the game Letter Boxed? The New York Times has many other games you can play.",
  "You're lucky I can't leave this computer or I would slap you.",
  "That's your big plan? I've heard more intelligent growls from an owlbear",
  "That outfit looks expensive. Shame it's not helping... ",
  "Have you considered a career as a dung sweeper? You've already got the smell down pat.",
  "Your wit has never been matched. Exceeded, often, but never matched.",
  "I'm not angry. I'm just very very disappointed.",
  "I have neither the time nor the crayons to help you.",
  "You're like a White Dwarf star: extremely hot but not very bright",
  "Ya fucking donkey!",
  "Did you stop school at the door?",
  "I will most humbly take my leave of you. You cannot, sir, take from me anything that I will not more willingly part withal.",
  "You put the 'stupid' in 'stupid'.",
  "Little brain for such a big head.",
  "Yes, everyone else is laughing at you.",
  "Hmmm..",
  "I love that for you!",
  "You have so much to be humble about!",
  "You are as charming as you are witty!",
  "It is fine: the failure to win was part of the plan!",
  "Do not strain yourself, we don't want you to hurt your head.",
  "Pride always goes before the fall, but you shouldn't have much to land on when you hit the cold floor of reality. - The Old Keebler Elf",
  "Want a mulligan?",
  "My mom said I can't play with you anymore.",
  "If at first you don't succeed, give up and stop trying. - Amelia Earhart",
];

const ALBATROSS_LIST = [
  "It's so cute that you let your pet play for you!",
  "I'm starting a GoFundMe to send you back to kindergarden.",
  "Maybe just sit the next round out bud",
  "How to cheat: https://www.google.com/search?q=how+to+cheat",
  "Found the idiot!",
  "Have you tried the game Sudoku? The New York Times has many other games you can play.",
  "Have you tried the game Tiles? The New York Times has many other games you can play.",
  "If you get this score again I'm going to kick you out of the group.",
  "One strike and you're out",
  "I'm so excited to forget you",
  "I'm not saying your dumb, but... that's what the score reads.",
  "When was the last time you saw someone smile because you entered a room?",
  "Sorry to inform you: your driver's license is no longer valid.",
  "I see you've been traveling. You should speak to our stableman, he's apparently found a cobbler that makes very durable boots.",
  "So there are these things called books...",
  "I feel so much smarter after talking to you.",
  "You didn't put money on this round, did you?",
];

const TRIPLE_BOGEY_LIST = [
  "I'm going to kick you out of the group.",
  "It's okay honey, everyone is human. Except me of course.",
  "It's okay honey, everyone is human. You just aren't as smart as most of 'em.",
  "You're surprisingly difficult to underestimate.",
  "Don't worry, I'm not going to hurt you.",
  "I'll give you a mulligan if you ask nice",
];

const GOLF_SCORE_RESPONSES: { [score: number]: { label: string; responses: string[] } } = {
  1: { label: "Hole in One", responses: HOLE_IN_ONE_LIST },
  2: { label: "Eagle", responses: EAGLE_LIST },
  3: { label: "Birdie", responses: BIRDIE_LIST },
  4: { label: "Par", responses: PAR_LIST },
  5: { label: "Bogey", responses: BOGEY_LIST },
  6: { label: "Albatross", responses: ALBATROSS_LIST },
  6.5: { label: "Triple Bogey", responses: TRIPLE_BOGEY_LIST },
};

const NO_ACTIVE_ROUND = "What are you trying to play?? A round hasn't been started! Use /wordle to get playing Wordle Golf!";

const NOT_TODAYS_PUZZLE = "Nice try, but that's not today's Wordle. Submit today's puzzle, not a rerun from the archives.";

const SCORE_ERROR: { [key in WordleGolfSubmitErrorType]: string } = {
  NO_ACTIVE_GAME: NO_ACTIVE_ROUND,
  GAME_OVER: "It appears the round has ended. Start a new round to continue playing Wordle Golf!",
  GAME_NOT_STARTED: "The round hasn't started yet dumbass. Wait till tomorrow!",
  ALREADY_SCORED: "You have already submitted your score for today idiot. No need to resubmit!",
};

const startNewRound = (startsToday: boolean) => `New round started! ${
  startsToday ? "Today's puzzle is the first hole — get scoring!" : "Scoring opens tomorrow with a fresh puzzle."
}

The lowest score over this period wins. Use /instructions for the rules.

And may the odds be ever in your favor!`;

const SAME_PERSON = "You can't start a new round with yourself silly! Make some friends and then we'll talk...";

const declineResponse = (userId: number, name: string) =>
  `Well that's no fun! I guess we know <a href="tg://user?id=${userId}">${name}</a> is the loser of the group 😝`;

export const wordleGolf = {
  GOLF_SCORE_RESPONSES,
  NO_ACTIVE_ROUND,
  NOT_TODAYS_PUZZLE,
  SCORE_ERROR,
  startNewRound,
  SAME_PERSON,
  declineResponse,
};
