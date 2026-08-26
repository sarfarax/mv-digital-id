'use strict';

/*
 * The demonstration issuing authority.
 *
 * The public key is the scanner's trust anchor: a card is only accepted if its
 * signature verifies against a key the verifier already trusts, which is what
 * stops anyone from minting their own cards. In a real deployment this key
 * would be published by the issuing authority and pinned in the verifier app,
 * and the secret key would live in a hardware security module and never leave
 * it.
 *
 * The secret key below is a throwaway committed to source control purely so the
 * demo runs out of the box. Treat it as public. Generate your own with:
 *
 *   node tools/make-keypair.mjs
 */

export const ISSUER = {
	name: 'Department of National Registration',
	country: 'Republic of Maldives',
	publicKey: '972d56fa0c5031dfbd48f186ab17dab12c773bcbc4d49c67ce45792f314b53a461d57d59967941876d15736b8b8dd529'
};

/** Demo signing key. Never do this in production. */
export const DEMO_SECRET_KEY = '4f2a8c1d6b3e9705a1c84f2d7b6e3059c4a8d1f26b93e70582cd4a1f6b8e3d07';

/*
 * A verifier may need to accept cards from more than one key at a time, for
 * example while a signing key is being rotated. The scanner walks this list and
 * accepts a card if any entry verifies.
 */
export const TRUSTED_KEYS = [
	{ label: ISSUER.name, publicKey: ISSUER.publicKey }
];
