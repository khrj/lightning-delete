import { PrismaClient } from "@prisma/client"
import { App, ExpressReceiver } from "@slack/bolt"
import { RTMClient } from "@slack/rtm-api"
import { WebClient } from "@slack/web-api"

const prisma = new PrismaClient()
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET!, endpoints: "/slack/events" })
const app = new App({
	receiver,
	token: process.env.SLACK_BOT_TOKEN,
})

const onlineSymbol = ":large_green_circle:"
const startingSymbol = ":large_orange_circle:"

interface OnlineUsersMap {
	[id: string]: boolean
}

let onlineUsersMap: OnlineUsersMap = {}

function listen(id: string, token: string) {
	const regexForD = /^[dD]*$/
	const rtm = new RTMClient(token)
	const web = new WebClient(token)

	rtm.on("message", (event) => {
		if (event.user === id && event.text) {
			const matched = event.text.match(regexForD)

			if (matched) {
				if (!event.thread_ts) {
					web.conversations.history({
						channel: event.channel,
					}).then(async history => {
						deleteMultiple(event.text.length, event.channel, history.messages as any[])
					})
				} else {
					collectReplies(event.channel, event.thread_ts).then(async messages => {
						deleteMultiple(event.text.length, event.channel, messages.reverse())
					})
				}
			}
		}
	})

	async function deleteMultiple(count: number, channel: string, messages: any[]) {
		let deleted = 0
		for (const message of messages) {
			if (message.user === id) {
				if (message.text && message.text.match(regexForD)) {
					web.chat.delete({
						channel: channel,
						ts: message.ts,
						as_user: true,
					})
				} else {
					try {
						await web.chat.delete({
							channel: channel,
							ts: message.ts,
							as_user: true,
						})
						deleted++
						if (deleted >= count) {
							break
						}
					} catch {
						// Race condition, fail safely
						// since it will not make a difference
						// (deleted is not incremented)
					}
				}
			}
		}
	}

	async function collectReplies(channel: string, thread_ts: string) {
		let replies: any[] = []
		async function getNext(cursor: string | undefined) {
			const history = await web.conversations.replies({
				channel: channel,
				ts: thread_ts,
				cursor: cursor,
			})
			replies.push(...(history.messages as any[]))
			if (history.has_more) {
				await getNext(history.response_metadata?.next_cursor)
			}
		}
		await getNext(undefined)
		return replies
	}

	rtm.start()
}

async function main() {
	if (
		!process.env.PORT
		|| !process.env.SLACK_SIGNING_SECRET
		|| !process.env.SLACK_CLIENT_SECRET
		|| !process.env.SLACK_CLIENT_ID
		|| !process.env.SLACK_BOT_TOKEN
	) {
		throw "Missing env variable: Check that the following are available: PORT, SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_BOT_TOKEN"
	}

	await app.start(parseInt(process.env.PORT))
	console.log("⚡️ Bolt app is running!")

	const users = await prisma.user.findMany({
		orderBy: {
			queuePostition: "asc",
		},
	})

	for (const { slackID } of users) {
		onlineUsersMap[slackID] = false
	}

	for (const { slackID, token } of users) {
		listen(slackID, token)
		onlineUsersMap[slackID] = true
		await new Promise(resolve => setTimeout(resolve, 60000))
	}
}

app.command("/lightning-status", async ({ command, ack, client }) => {
	await ack()
	let build = ":zap: Lightning Delete Status (one user goes online each minute due to rate limits):\n\n"

	for (const [user, online] of Object.entries(onlineUsersMap)) {
		build += `${online ? onlineSymbol : startingSymbol} <@${user}>\n`
	}

	await client.chat.postEphemeral({
		channel: command.channel_id,
		user: command.user_id,
		text: build,
	})
})

receiver.app.get("/auth", async (req, res) => {
	try {
		const response = await app.client.oauth.access({
			client_id: process.env.SLACK_CLIENT_ID!,
			client_secret: process.env.SLACK_CLIENT_SECRET!,
			code: req.query.code as string,
		})

		await prisma.user.upsert({
			where: { slackID: response.user_id as string },
			update: { token: response.access_token as string },
			create: {
				slackID: response.user_id as string,
				token: response.access_token as string,
			},
		})

		listen(response.user_id as string, response.access_token as string)

		res.send("Authed successfully")
	} catch (e) {
		res.redirect("/")
		console.log(e)
	}
})

receiver.app.get("/", (_, res) => {
	res.redirect("https://slack.com/oauth/authorize?client_id=2210535565.1603461050646&scope=client")
})

main()
	.catch(e => {
		throw e
	})
	.finally(async () => {
		await prisma.$disconnect()
	})
