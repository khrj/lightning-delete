const { RTMClient } = require('@slack/rtm-api')
const { WebClient } = require('@slack/web-api')
const { App, ExpressReceiver } = require('@slack/bolt')

const { PrismaClient } = require("@prisma/client")
const prisma = new PrismaClient()

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET, endpoints: '/slack/events' })

const app = new App({
    receiver,
    token: process.env.SLACK_BOT_TOKEN,
})

const onlineSymbol = ":large_green_circle:"
const startingSymbol = ":large_orange_circle:"

let onlineUsersMap = {}

async function main() {
    await app.start(process.env.PORT || 3000)
    console.log('⚡️ Bolt app is running!')

    // RTM

    const regexForD = /^[dD]*$/
    function listen(id, token) {
        const rtm = new RTMClient(token)
        const web = new WebClient(token)

        rtm.on('message', (event) => {
            if (event.user === id && event.text) {
                const matched = event.text.match(regexForD)

                if (matched) {
                    if (!event.thread_ts) {
                        web.conversations.history({
                            channel: event.channel
                        }).then(async history => {
                            deleteMultiple(event.text.length, event.channel, history.messages)
                        })
                    } else {
                        collectReplies(event.channel, event.thread_ts).then(async messages => {
                            deleteMultiple(event.text.length, event.channel, messages.reverse())
                        })
                    }
                }
            }
        })

        async function deleteMultiple(count, channel, messages) {
            let deleted = 0
            for (const message of messages) {
                if (message.user === id) {
                    if (message.text && message.text.match(regexForD)) {
                        web.chat.delete({
                            channel: channel,
                            ts: message.ts,
                            as_user: true
                        })
                    } else {
                        try {
                            await web.chat.delete({
                                channel: channel,
                                ts: message.ts,
                                as_user: true
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

        async function collectReplies(channel, thread_ts) {
            let replies = []
            async function getNext(cursor) {
                const history = await web.conversations.replies({
                    channel: channel,
                    ts: thread_ts,
                    cursor: cursor
                })
                replies.push(...history.messages)
                if (history.has_more) {
                    await getNext(history.response_metadata.next_cursor)
                }
            }
            await getNext(undefined)
            return replies
        }

        rtm.start()
    }

    const users = await prisma.user.findMany({
        orderBy: {
            queuePostition: 'asc',
        },
    })

    for (const { slackID, token } of users) {
        onlineUsersMap[slackID] = false
    }

    for (const { slackID, token } of users) {
        listen(slackID, token)
        onlineUsersMap[slackID] = true
        await new Promise(resolve => setTimeout(resolve, 60000))
    }
}

app.command('/lightning-status', async ({ command, ack, client }) => {
    await ack()
    let build = ":zap: Lightning Delete Status (one user goes online each minute due to rate limits):\n\n"

    for (const [user, online] of Object.entries(onlineUsersMap)) {
        build += `${online ? onlineSymbol : startingSymbol} <@${user}>\n`
    }

    await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: build
    })
})

receiver.app.get('/auth', async (req, res) => {
    try {
        const response = await app.client.oauth.access({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code: req.query.code
        })

        await prisma.user.upsert({
            where: { slackID: response.user_id },
            update: { token: response.access_token },
            create: {
                slackID: response.user_id,
                token: response.access_token
            }
        })

        listen(response.user_id, response.access_token)

        res.send('Authed successfully')
    } catch (e) {
        res.redirect('/')
        console.log(e)
    }
})

receiver.app.get('/', (_, res) => {
    res.redirect("https://slack.com/oauth/authorize?client_id=2210535565.1603461050646&scope=client")
})

receiver.app.get('/ping', (_, res) => {
    res.send('Online')
})

main()
