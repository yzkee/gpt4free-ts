import {Chat, ChatOptions, ChatRequest, ChatResponse, ModelType} from "../base";
import {Browser, EventEmitter, Page} from "puppeteer";
import {BrowserPool, BrowserUser} from "../../pool/puppeteer";
import {DoneData, ErrorData, Event, EventStream, isSimilarity, MessageData, parseJSON, sleep} from "../../utils";
import {v4} from "uuid";
import moment from 'moment';
import TurndownService from 'turndown';

const turndownService = new TurndownService({codeBlockStyle: 'fenced'});

type PageData = {
    gpt4times: number;
}

const ModelMap: Partial<Record<ModelType, any>> = {
    [ModelType.GPT4]: 'GPT-4',
    [ModelType.Sage]: 'Sage',
    [ModelType.Claude]: 'Claude+',
    [ModelType.Claude100k]: 'Claude-instant-100k+',
    [ModelType.ClaudeInstance]: 'Claude-instant',
    [ModelType.GPT3p5Turbo]: 'ChatGPT',
    [ModelType.GPT3p5_16k]: 'ChatGPT-16k',
    [ModelType.Gpt4free]: '1GPT4Free',
    [ModelType.GooglePalm]: 'Google-PaLM',
    [ModelType.Claude2_100k]: 'Claude-2-100k',
    [ModelType.GPT4_32k]: 'GPT-4-32K',
}

const MaxGptTimes = 500;

const TimeFormat = "YYYY-MM-DD HH:mm:ss";

type Account = {
    id: string;
    email?: string;
    login_time?: string;
    last_use_time?: string;
    gpt4times: number;
    pb: string;
    failedCnt: number;
}

type HistoryData = {
    data: {
        query: string;
        result: string;
        created_at: string;
    }[]
}

interface Messages {
    id: string;
    messageId: number;
    creationTime: number;
    clientNonce: null;
    state: string;
    text: string;
    author: string;
    linkifiedText: string;
    contentType: string;
    attachments: any[];
    vote: null;
    suggestedReplies: string[];
    linkifiedTextLengthOnCancellation: null;
    textLengthOnCancellation: null;
    voteReason: null;
    __isNode: string;
}

interface Data {
    messageAdded: Messages;
}

interface Payload {
    unique_id: string;
    subscription_name: string;
    data: Data;
}

interface RootObject {
    message_type: string;
    payload: Payload;
}

interface RealAck {
    messages: string[];
    min_seq: number;
}

class PoeAccountPool {
    private pool: Account[] = [];
    private using = new Set<string>();

    constructor() {
        this.pool = (process.env.POE_PB || '').split('|').map(pb => ({
            id: v4(),
            gpt4times: 0,
            pb,
            failedCnt: 0,
        } as Account));
    }

    public syncfile() {
    }

    public getByID(id: string) {
        for (const item of this.pool) {
            if (item.id === id) {
                return item;
            }
        }
    }

    public delete(id: string) {
        this.pool = this.pool.filter(item => item.id !== id);
        this.using.delete(id);
        this.syncfile();
    }

    public get(): Account {
        const now = moment();
        const usingAccount: Account[] = [];
        this.using.forEach(id => {
            const v = this.getByID(id);
            if (v) {
                usingAccount.push(v);
            }
        });
        for (const item of this.pool) {
            if (!usingAccount.find(v => item.pb === v.pb)) {
                this.using.add(item.id);
                return item;
            }
        }
        return {
            id: v4(),
            gpt4times: 0,
            pb: '',
            failedCnt: 0,
        } as Account
    }
}


export class Poe extends Chat implements BrowserUser<Account> {
    private pagePool: BrowserPool<Account>;
    private accountPool: PoeAccountPool;

    constructor(options?: ChatOptions) {
        super(options);
        this.accountPool = new PoeAccountPool();
        let maxSize = (process.env.POE_PB || '').split('|').length;
        this.pagePool = new BrowserPool<Account>(maxSize, this);
    }

    support(model: ModelType): number {
        switch (model) {
            case ModelType.ClaudeInstance:
                return 4000;
            case ModelType.Claude100k:
                return 50000;
            case ModelType.Claude:
                return 4000;
            case ModelType.GPT4:
                return 6000;
            case ModelType.GPT3p5Turbo:
                return 3000;
            case ModelType.GPT3p5_16k:
                return 15000;
            case ModelType.Gpt4free:
                return 4000;
            case ModelType.Sage:
                return 4000;
            case ModelType.GooglePalm:
                return 4000;
            case ModelType.GPT4_32k:
                return 28000;
            case ModelType.Claude2_100k:
                return 80000
            default:
                return 0;
        }
    }

    public async ask(req: ChatRequest): Promise<ChatResponse> {
        const et = new EventStream();
        const res = await this.askStream(req, et);
        const result: ChatResponse = {
            content: '',
        };
        return new Promise(resolve => {
            et.read((event, data) => {
                if (!data) {
                    return;
                }
                switch (event) {
                    case 'message':
                        result.content += (data as MessageData).content;
                        break;
                    case 'done':
                        result.content += (data as DoneData).content;
                        break;
                    case 'error':
                        result.error += (data as ErrorData).error;
                        break;
                    default:
                        console.error(data);
                        break;
                }
            }, () => {
                resolve(result);
            });
        })
    }

    deleteID(id: string): void {
        this.accountPool.delete(id);
    }

    newID(): string {
        const account = this.accountPool.get();
        return account.id;
    }

    async init(id: string, browser: Browser): Promise<[Page | undefined, Account]> {
        const account = this.accountPool.getByID(id);
        if (!account) {
            await sleep(10 * 24 * 60 * 60 * 1000);
            return [] as any;
        }
        const [page] = await browser.pages();
        try {
            await page.setCookie({name: 'p-b', value: account.pb, domain: 'poe.com'});
            await page.goto(`https://poe.com/GPT-4-32K`)
            await page.waitForSelector(Poe.InputSelector, {timeout: 30 * 1000, visible: true});
            await page.click(Poe.InputSelector);
            await page.type(Poe.InputSelector, `1`);
            const isVip = await Poe.isVIP(page);
            if (!isVip) {
                console.warn(`account:${account?.pb}, not vip`);
                await sleep(10 * 24 * 60 * 60 * 1000);
            }
            return [page, account];
        } catch (e) {
            console.warn(`account:${account?.pb}, something error happened,err:`, e);
            await sleep(10 * 24 * 60 * 60 * 1000);
            return [] as any;
        }
    }

    public static async isVIP(page: Page) {
        try {
            await page.waitForSelector(Poe.FreeModal, {timeout: 10 * 1000});
            return false;
        } catch (e) {
            return true;
        }
    }

    public static async clear(page: Page) {
        await page.waitForSelector('.ChatApp > .ChatFooter > .tool-bar > .semi-button:nth-child(1) > .semi-button-content', {timeout: 10 * 60 * 1000});
        await page.click('.ChatApp > .ChatFooter > .tool-bar > .semi-button:nth-child(1) > .semi-button-content')
    }

    public static InputSelector = '.ChatPageMainFooter_footer__Hm4Rt > .ChatMessageInputFooter_footer__1cb8J > .ChatMessageInputContainer_inputContainer__SQvPA > .GrowingTextArea_growWrap___1PZM > .GrowingTextArea_textArea__eadlu';
    public static ClearSelector = '.ChatPageMainFooter_footer__Hm4Rt > .ChatMessageInputFooter_footer__1cb8J > .Button_buttonBase__0QP_m > svg > path';
    public static FreeModal = ".ReactModal__Body--open > .ReactModalPortal > .ReactModal__Overlay > .ReactModal__Content";

    public async askStream(req: ChatRequest, stream: EventStream) {
        // req.prompt = req.prompt.replace(/\n/g, ' ');
        const [page, account, done, destroy] = this.pagePool.get();
        if (page?.url().indexOf(ModelMap[req.model]) === -1) {
            await page?.goto(`https://poe.com/${ModelMap[req.model]}`, {waitUntil: 'networkidle0'});
        }
        if (!account || !page) {
            stream.write(Event.error, {error: 'please retry later!'});
            stream.write(Event.done, {content: ''})
            stream.end();
            return;
        }
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        try {
            let old = '';
            let et: EventEmitter;
            const tt = setTimeout(async () => {
                client.removeAllListeners('Network.webSocketFrameReceived');
                account.failedCnt += 1;
                if (account.failedCnt >= 20) {
                    destroy(true, true);
                    console.log(`poe account failed cnt > 20, destroy ok`);
                } else {
                    await page.reload();
                    done(account);
                }
                if (!stream.stream().writableEnded && !stream.stream().closed) {
                    console.error('poe wait ack ws timeout, retry!');
                    await this.askStream(req, stream);
                }
            }, 10 * 1000);
            let currMsgID = '';
            et = client.on('Network.webSocketFrameReceived', async ({response}) => {
                tt.refresh();
                const data = parseJSON(response.payloadData, {} as RealAck);
                const obj = parseJSON(data.messages[0], {} as RootObject);
                const {unique_id} = obj.payload || {};
                const message = obj?.payload?.data?.messageAdded;
                if (!message) {
                    return;
                }
                const {author, state, text} = message;
                // console.log(author, state, text, unique_id);

                if (author === 'chat_break') {
                    return;
                }
                if (author === 'human' && isSimilarity(text, req.prompt)) {
                    currMsgID = unique_id;
                    return;
                }
                if (unique_id !== currMsgID) {
                    // console.log(`message id different`, {unique_id, currMsgID});
                    return;
                }
                switch (state) {
                    case 'complete':
                        clearTimeout(tt);
                        client.removeAllListeners('Network.webSocketFrameReceived');
                        stream.write(Event.message, {content: text.substring(old.length)});
                        stream.write(Event.done, {content: ''});
                        stream.end();
                        await page.waitForSelector(Poe.ClearSelector);
                        await page.click(Poe.ClearSelector);
                        account.failedCnt = 0;
                        done(account);
                        console.log('poe recv msg complete')
                        return;
                    case 'incomplete':
                        stream.write(Event.message, {content: text.substring(old.length)});
                        old = text;
                        return;
                }
            })
            console.log('poe start send msg');
            await page.waitForSelector(Poe.ClearSelector);
            await page.click(Poe.ClearSelector);
            await page.waitForSelector(Poe.InputSelector)
            await page.click(Poe.InputSelector);
            await page.type(Poe.InputSelector, `1`);
            console.log('poe find input ok');
            const input = await page.$(Poe.InputSelector);
            //@ts-ignore
            await input?.evaluate((el, content) => el.value = content, req.prompt);
            await page.keyboard.press('Enter');
            console.log('send msg ok!');
        } catch (e) {
            client.removeAllListeners('Network.webSocketFrameReceived');
            console.error(`account: pb=${account.pb}, poe ask stream failed:`, e);
            done(account);
            stream.write(Event.error, {error: 'some thing error, try again later'});
            stream.write(Event.done, {content: ''})
            stream.end();
            return
        }
    }
}
