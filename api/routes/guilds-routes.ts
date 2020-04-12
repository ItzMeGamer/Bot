import { Router } from 'express';
import config from '../../config.json';
import { SavedGuild } from '../../models/guild';
import { SavedMember } from '../../models/member';
import Leveling from '../../modules/xp/leveling';
import { AuthClient } from '../server';
import { XPCardGenerator } from '../modules/image/xp-card-generator';
import { bot } from '../../bot';
import Deps from '../../utils/deps';
import Members from '../../data/members';
import Ranks from '../modules/ranks';
import Users from '../../data/users';
import Guilds from '../../data/guilds';
import Logs from '../../data/logs';
import AuditLogger from '../modules/audit-logger';

export const router = Router();

const logs = Deps.get<Logs>(Logs),
      members = Deps.get<Members>(Members),
      users = Deps.get<Users>(Users),
      guilds = Deps.get<Guilds>(Guilds);

router.get('/', async (req, res) => {
    try {        
        const guilds = await getManagableGuilds(req.query.key);
        res.json(guilds);
    } catch (error) { res.status(400).send(error); }
});

router.put('/:id/:module', async (req, res) => {
    try {             
        const { id, module } = req.params; 
        
        const isValidModule = config.modules.some(m => m.toLowerCase() === module);
        if (!isValidModule)
            throw new TypeError();

        await validateGuildManager(req.query.key, id);

        const user = await getUser(req.query.key);
        const savedGuild = await SavedGuild.findById(id).lean();
        
        const change = AuditLogger.getChanges({
            old: savedGuild[module],
            new: req.body
        }, module, user.id);

        savedGuild[module] = req.body;
        await SavedGuild.findByIdAndUpdate(id, savedGuild);

        const guild = bot.guilds.cache.get(id);        
        const log = await logs.get(guild);
        
        log.changes.push(change);
        await log.save();
            
        res.json(savedGuild);
    } catch (error) { res.status(400).send(error); console.log(error) }
});

router.get('/:id/config', async (req, res) => {
    try {
        const id = req.params.id;
        const savedGuild = await SavedGuild.findById(id).lean();
        res.json(savedGuild);
    } catch { res.status(400).send('Bad Request'); }
});

router.get('/:id/channels', async (req, res) => {
    try {
        const guild = bot.guilds.cache.get(req.params.id);
        res.send(guild.channels.cache);        
    } catch { res.status(400).send('Bad Request'); }
});

router.get('/:id/log', async(req, res) => {
    try {
        const id = req.params.id;
        // await validateGuildManager(req.query.key, id);

        const guild = bot.guilds.cache.get(id);
        const log = await logs.get(guild);
        res.send(log);
    } catch { res.status(400).send('Bad Request'); }
});

router.get('/:id/public', (req, res) => {
    const guild = bot.guilds.cache.get(req.params.id);
    res.json(guild);
});

router.get('/:id/roles', async (req, res) => {
    try {
        const guild = bot.guilds.cache.get(req.params.id);
        res.send(guild.roles.cache.filter(r => r.name !== '@everyone'));        
    } catch { res.status(404).send('Not Found'); }
});

router.get('/:id/members', async (req, res) => {
    try {
        const members = await SavedMember.find({ guildId: req.params.id }).lean();
        const guild = await SavedGuild.findById(req.params.id).lean();
        
        let rankedMembers = [];
        for (const savedMember of members) {
            const member = bot.users.cache.get(savedMember.id);
            const xp = Leveling.xpInfo(savedMember.xpMessages, guild.xp.xpPerMessage);
    
            rankedMembers.push({
                id: member.id,
                username: member.username,
                tag: '#' + member.discriminator,
                displayAvatarURL: member.displayAvatarURL(),
                ...xp,
                xpMessages: savedMember.xpMessages
            });
        }
        rankedMembers.sort((a, b) => b.xpMessages - a.xpMessages);
    
        res.json(rankedMembers);
    } catch { res.status(400).send('Bad Request'); }
});

async function getManagableGuilds(key: string) {
    const manageableGuilds = [];
    let userGuilds = await AuthClient.getGuilds(key);    
    for (const id of userGuilds.keys()) {        
        const authGuild = userGuilds.get(id);        
        const hasManager = authGuild._permissions
            .some(p => p === config.api.managerPermission);

        if (hasManager)
            manageableGuilds.push(id);
    }    
    return bot.guilds.cache
        .filter(g => manageableGuilds.some(id => id === g.id));
}

router.get('/:guildId/members/:memberId/xp-card', async (req, res) => {
    try {
        const { guildId, memberId } = req.params;

        const user = bot.users.cache.get(memberId);             
        const savedUser = await users.get(user); 

        const guild = bot.guilds.cache.get(guildId);
        const member = guild?.members.cache.get(memberId);        
        if (!member)
            throw Error();
        
        const savedMember = await members.get(member);  
        const savedMembers = await SavedMember.find({ guildId });
        const rank = Ranks.get(member, savedMembers);
        
        const savedGuild = await guilds.get(guild);
        const generator = new XPCardGenerator(savedUser, rank, 
            savedGuild.xp.xpPerMessage);
        const image = await generator.generate(savedMember);
        
        res.set({'Content-Type': 'image/png'}).send(image);
    }
    catch (error) { res.status(400).send('Bad Request'); console.log(error);
     }
});

async function validateGuildManager(key: string, id: string) {
    if (!key)
        throw new Error();
    const guilds = await getManagableGuilds(key);        
        
    if (!guilds.has(id))
        throw Error();
}

async function getUser(key: string) {
    const { id } = await AuthClient.getUser(key);
    return bot.users.cache.get(id);
}