const { RTMClient } = require('@slack/rtm-api')
const { WebClient } = require('@slack/web-api')
const { PrismaClient } = require("@prisma/client")
const app = require('express')()
const prisma = new PrismaClient()

const botClient = new WebClient(process.env.SLACK_BOT_TOKEN)

async function main() {
    function listen(id, token) {
        const rtm = new RTMClient(token)
        const web = new WebClient(token)

        rtm.on('message', (event) => {
            if (event.user === id && event.text) {
                const matched = event.text.match(/^d*$/)

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
                    if (message.text && message.text.match(/^d*$/)) {
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
                if(history.has_more) {
                    await getNext(history.response_metadata.next_cursor)  
                }
            }
            await getNext(undefined)
            return replies
        } 

        rtm.start()
    }

    const users = await prisma.user.findMany()

    for (const { slackID, token } of users) {
        listen(slackID, token)
    }

    app.get('/auth', async (req, res) => {
        try {
            const response = await botClient.oauth.access({
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

    app.get('/', (_, res) => {
        res.redirect("https://slack.com/oauth/authorize?client_id=2210535565.1603461050646&scope=client")
    })

    app.get('/ping', (_, res) => {
        res.send('Online')
    })

    app.listen(3000, () => {
        console.log('Server started ⚡️')
    })
}

main()