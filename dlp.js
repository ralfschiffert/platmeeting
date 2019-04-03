// this example serves as compliance example for calling within Webex Teams
// it works like this
// first it registers for 3 different webhooks:
// resource:call event:updated filter:status=disconnected
// resource:callMembership event:updated filter:status=joined
// resource:callMembership event:created filter:status=joined

// we register for 3 different webhooks:
// resource:call event:updated filter:status=disconnected
// resource:callMembership event:updated filter:status=joined
// resource:callMembership event:created filter:status=joined

// whenever we get a membership webhook, we add the personID/membership to an associative array
// if the array does not yet exist, we will build it
// thankfully the callMembership webhook has the callID in it, so
// I don't need to do any lookup.
// the associative array may look like this
// CallIDY28s8s[ membershipidY2993939 ];
// with each new membership joined event I will add the member to the array for this callID ( or create a new one )
// CallIDY28s8s[ membershipidY2993939 , membershipIdY2993940]

// Whenever I add a member to the array I will check if there is a policy violation. If there is I will hangup on
// that person, for example I could hangup up on membershipIdY2993940
// the array would then look like CallIDY28s8s[ membershipidY2993939 ]
// If the person rejoins I will see the same violation and can remove them again.
// Last if the call-disconnected-webhook fires I will remove the whole array for good.


// support http requests
const got = require('got')

// we should use oAuth mechanism
const ADMIN_TOKEN = "ZDYzMmU5NWItYWRiZS00Y2FmLTg2ZWUtM2VkZDk1NWE4NGNmNTc4MzZiNDgtMDFk_PF84_ce861fba-6e2f-49f9-9a84-b354008fac9e"

// these people should not be in the same call
const peopleWhoShouldNotTalk = [ "raschiff@cisco.com", "krs3@schiffert.me"]

// this is the data structure we use to store all calls in the system
// the people itself will be stored as Sets in the map
const calls = new Map();

const person2CallMembership = new Map();

// interact with the teams API via a client object
const teams = require('ciscospark').init({
  credentials: {
    access_token: ADMIN_TOKEN // process.env.TEAMS_ADMIN_TOKEN
  }
})


var myApp = {
  // these people should all have Webex Teams account ideally

  webhookUrl: "", // webhookinbox 3rd party server to receive our webhooks on who joined
  webhooks: [], // list of webhook objects so we can remove them at the end
  webhooks2Add: [],
  idsWhoShouldNotTalk: [],
  memberships2BRemoved: [],
  forbiddenPeopleInCall: [],

  init:  function() {

    let kickoffPromise =  this.deleteAllAccountWebhooks()
      .then( () => this.resolvePeople2Id() )
      .then( () => this.createWebhookInbox())
      .then( (webhookinbox) => { console.log( "http://webhookinbox.com/view/" + webhookinbox.split("/").splice(-2)[0])})
      .then( () => this.setupWebhookData())
      .then( () => this.createWebhooks())
      .then( v => {console.log(v)})
      .then( () => {  return this.setupDelay(20) })
      .then( () => { return this.checkWhoCalledIn()})
      .then( () => { return this.checkForDLPDisallowed()})
      .then(console.log)
      .then( () => { return this.hangupOnViolators()})
      .then( () => { return this.remindViolatorsInDirectMessage()})

      //this.resolvePeople2Id()
      //.then(console.log)
      //  console.log("webhookInbox at http://webhookinbox.com/view/" + inboxUrl.split("/").slice(-2)[0] + "/")
      //.then(this.createWebhookInbox())
      //.then(this.webhookUrl)
      //.then(this.createWebhooks())
      //.catch(console.log)
    // authorizes the client and stores access in the teams object so we never have to explicitly authenticate
    // let kickoffPromise = teams.authorization.requestAccessTokenFromJwt({jwt: guestToken})
    // webhookinbox is a 3rd party website - the only reason I am using it so I don't have to run a server
    // locally, which some companies don't allow
    // instead I am creating a way to deposit a webhook on this site and then poll the site for who joined
  //    .then( () => { return this.createWebhookInbox() })
      // we convert email addresses to id's since it makes it easier to track who joined the meeting
      // the webhooks are keyed in personId's, not emails
    //  .then( () => { return this.resolvePeople2Id() })
      //.then( () => { return this.createSpace() })
      // when creating a room it doesn't give us back the room details
      // instead we need to query the room to get these details
     // .then( () => { return this.lookupSpaceDetails() })
      // now we can add the people to the space
      //.then( () => { return this.addMembersById2Space() })
      // now we register for each member a webhook which fires for when they are joined to the meeting
     // .then( () => { return this.createWebhooks() })
     // .then( () => { return this.postMessage("Welcome to the " + this.roomTitle + " huddle space") })
     // .then( () => { return this.callSpace() })
      // let's give people a couple of seconds to join
     // .then( () => {  return this.setupDelay(20) })
     // .then( () => { return this.checkWhoCalledIn() })
     // .then( () => { return this.remindSlackersInDirectMessage("Hey, can you join our call in the " +
    // this.roomTitle + " space") })
     // .then( () => {  return this.setupDelay(20) })
      // let's clean  up
     // .then( () => { return this.cleanupMeeting() })
     // .catch(console.log)
  },
  deleteAllAccountWebhooks: function () {

    return teams.webhooks.list({max: 100})
      .then(w => w.items.map(i => {
        return teams.webhooks.remove(i.id)
      }))
      .then(
        w => {
          return Promise.all(w)
        })
      .catch(console.log)

  },
  setupWebhookData: function() {

    // webhooks
    const wh1 = {
      name: "callJoined",
      resource: "callMemberships",
      event: "created",
      filter: "status=joined",
      targetUrl: this.webhookUrl + 'in/',
      ownedBy: "org"
    }

    let webhookSet = this.idsWhoShouldNotTalk.map( i => { return Object.assign({},wh1,{filter: `${wh1.filter}&personId=${i}`})})
    let wh2 = Object.assign({}, wh1, {event: "updated"})
    // the spread operator splits the array into its constituents
    // otherwise we would have an array in an array
    webhookSet.push(...this.idsWhoShouldNotTalk.map( i => { return Object.assign({},wh2,{filter: `${wh2.filter}&personId=${i}`})}))

    // callMemberships
    return Promise.resolve(this.webhooks2Add = webhookSet)

    // calls
    // wh3
  },
  createWebhooks: function() {

    return Promise.all(
      this.webhooks2Add.map(i => {
        return teams.webhooks.create(i)
      }),
    ).then( w => this.webhooks = w ).catch(console.log)
  },
  createWebhookInbox: function() {
    // the webhookinbox is just so we don't have to run a server
    // instead we are going to poll for events from it
    // frankly we could also poll from the events API but then it's not so awesome to watch
    return got('http://api.webhookinbox.com/create/', { method: 'POST'})
      .then( res =>
        {
          return this.webhookUrl = JSON.parse(res.body).base_url;
        })
  },
  resolvePeople2Id: function() {
    // this returns a promise with an array of the peopleId's associated with the people2Add array, which we setup as
    // email addresses
    // the API does not always support addressing people by email. We sometimes need the peopleId instead
    return Promise.all(peopleWhoShouldNotTalk.map(i => teams.people.list({email: i}).then(p => p.items[0].id))).then( a => { return this.idsWhoShouldNotTalk=a } )
  },
  createSpace: function() {
    return teams.rooms.create({title: this.roomTitle}).then(r => {
      return this.roomId = r.id
    })
  },
  lookupSpaceDetails: function() {
    // we need to do thjs to access the SIP URI of this space, which is not returned in the room creation
    return teams.rooms.get(this.roomId).then( r => { return this.roomSipUri = r.sipAddress })
  },
  addMembersByEmail2Space: function(people) {
    return Promise.all(
      people.map( (m) => {
        return teams.memberships.create({ roomId: this.roomId, personEmail: m})
      }))
  },
  addMembersById2Space: function() {
    return Promise.all(
     this.people2AddIds.map( id => {
       return teams.memberships.create({ roomId: this.roomId, personId: id})
     })
    )
      .then( a => a.map( i => { this.people2Remind.unshift(i.personId) }))
      .then( () => { return this.people2Remind })
  },
  postMessage: function(msg) {
    return teams.messages.create({roomId: this.roomId, text: msg})
  },
  setupDelay: function (time) {
    let timeMs = time * 1000
    // some helper function that helps us wait before we poll who joined
    return new Promise( res => {
      setTimeout( () => { res(timeMs)}, timeMs)
    })
  },
  removeSpace: function() {
    // when the call is done we should remove the space
    // this will delete all memberships in the space as well
    // all ongoing calls will be deleted as well
    return teams.rooms.delete(this.roomId)
  },
  checkWhoCalledIn: function() {
    return got(this.webhookUrl+'items/').then( l => {

      let a = JSON.parse(l.body).items; // this is the whole result page

      // let's get person by person
      a.map( i => {
        let result = JSON.parse(i.body)
        let callId = result.data.callId
        let personId = result.data.personId
        let callMembershipId = result.data.id
        person2CallMembership.set(personId, callMembershipId)

        // let's check if we have the callId already
        if (calls.has(callId)) {
          //get the set and add the person
          calls.get(callId).add(personId) // if the personId is already there, no harm is done
        } else {
          calls.set(callId, new Set().add(personId)) // empty set of people
        }
      })
    })
  },
  checkForDLPDisallowed: function() {

    // iterate over all calls
    for (const c of calls.keys()) {
      this.forbiddenPeopleInCall = this.idsWhoShouldNotTalk.filter(x => calls.get(c).has(x))

      if ( this.forbiddenPeopleInCall.length >= 2 ) {
        this.memberships2BRemoved.push(...this.forbiddenPeopleInCall.map( pid => person2CallMembership.get(pid)))
      }
    }

    return this.memberships2BRemoved
  },
  hangupOnViolators: function() {

       console.log("START")
    console.log(this.memberships2BRemoved)
    console.log("END")

      this.memberships2BRemoved.map( i => {
        got('https://api.ciscospark.com/v1/call/commands/hangup',
          {
            method: 'POST',
            headers: {
              'Authorization' : 'Bearer ' + ADMIN_TOKEN,
              'Content-type' : 'application/json'
            },
            json: true,
            body: {
              "callMembershipId" : i
            }
          })
          .catch(console.log)
        })
  },
  remindViolatorsInDirectMessage: function() {
    return Promise.all(
      this.forbiddenPeopleInCall.map( i => {
        teams.messages.create({toPersonId: i, text: "Your call has ended due to a policy violation"})
      })
    )
  },
  cleanupMeeting: function() {
    return twilio.calls(this.twilioCallSid).update({status: 'completed'})
      .then( () => { return teams.rooms.remove(this.roomId) })
      .then( () =>  { return Promise.all(
        this.webhooks.map( w => teams.webhooks.remove(w) )
      )})
  }
}

myApp.init()
