export function isValidArchiveAccessTicket(ticket, uid) {
    return Boolean(
        ticket &&
        ticket.kind === "caca-archive-access" &&
        typeof uid === "string" &&
        uid.length > 0 &&
        ticket.uid === uid
    );
}
