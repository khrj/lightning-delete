const { randomBytes } = require("crypto")
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const { InstallProvider } = require('@slack/oauth')
const { SocketModeClient } = require('@slack/socket-mode')
const { WebClient } = require('@slack/web-api')

// Initialize
const socketClient = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN })
const web = new WebClient()
const installer = new InstallProvider({
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    stateSecret: randomBytes(20).toString('hex'),
    installationStore: {
        storeInstallation: async (installation) => {
            await prisma.user.upsert({
                where: { slackID: installation.user.id },
                create: {
                    slackID: installation.user.id,
                    installation: JSON.stringify(installation)
                },
                update: {
                    installation: JSON.stringify(installation)
                }
            })
        },
        fetchInstallation: async (InstallQuery) => {
            const user = await prisma.user.findUnique({
                where: {
                    slackID: InstallQuery.userId
                }
            })
            return JSON.parse(user.installation)
        },
    },
})

socketClient.on('message', async ({ ack, event }) => {
    await ack()
    try {
        if (event.text) {
            const matched = event.text.match(/^d*$/)

            if (matched) {
                const { userToken: token } = await installer.authorize({ userId: event.user })
                if (!event.thread_ts) {
                    web.conversations.history({
                        token,
                        channel: event.channel
                    }).then(async history => {
                        deleteMultiple(event.text.length, event.channel, history.messages)
                    })
                } else {
                    collectReplies(event.channel, event.thread_ts).then(async messages => {
                        deleteMultiple(event.text.length, event.channel, messages.reverse())
                    })
                }

                async function deleteMultiple(count, channel, messages) {
                    let deleted = 0
                    for (const message of messages) {
                        if (message.user === event.user) {
                            if (message.text && message.text.match(/^d*$/)) {
                                web.chat.delete({
                                    token,
                                    channel: channel,
                                    ts: message.ts,
                                    as_user: true
                                })
                            } else {
                                try {
                                    await web.chat.delete({
                                        token,
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
                            token,
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
            }
        }
    } catch (error) {
        console.error(error)
    }
})

async function main() {
    await socketClient.start()
    console.log('Lightning Delete running ⚡️')
}
main()

const server = require('express')()

server.get('/', async (req, res) => {
    const url = await installer.generateInstallUrl({
        scopes: ["chat:write"],
        userScopes: ['channels:history', 'groups:history', 'mpim:history', 'im:history', 'chat:write'],
    })
    res.redirect(url)
})

server.get('/slack/oauth_redirect', async (req, res) => {
    await installer.handleCallback(req, res)
})

server.get('/ping', async (req, res) => {
    res.send("Online")
})

server.listen(3000, () => {
    console.log(`Authenticator listening at *:3000`)
})