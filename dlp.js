// this example serves as compliance example for calling within Webex Teams
// it works like this
// first it registers for 3 different webhooks:
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
// for 2 attendees it may look like this
// CallIDY28s8s[ membershipidY2993939 , membershipIdY2993940]

// Whenever I add a member to the array I will check if there is a policy violation. If there is I will hangup on
// that person, for example I could hangup up on membershipIdY2993940
// the array would then look like CallIDY28s8s[ membershipidY2993939 ]
// If the person rejoins I will see the same violation and can remove them again.
// Last if the call-disconnected-webhook fires I will remove the whole array for good.


// console color markup
const chalk = require('chalk')
// support http requests
const got = require('got')
// highland streams have some interesting capabilites that native streams don't support yet
const highland = require('highland')

// stream parse the webhooks data
const ts = require('JSONStream')
const ts1 = ts.parse('body')
// gets the webhook payload data section
// there are some issues with escaped quotes \" which is why this needs to be parsed in two steps instead of 1
// the first step does as a side effect remove the escaped quotes
const ts2 = ts.parse('data')

// interact with the teams API via a client object
const teams = require('ciscospark').init({
  credentials: {
    // for purposes of this program - to see any calls that happen in the org - this needs to be a token with the
    // scopes spark-admin:calls_read and spark-admin:call_memberships_read
    access_token: process.env.ADMIN_TOKEN
  }
})


// DLP POLICY - DLP POLICY - DLP POLICY
// This is our 1 line DLP policy - members in this array should not be in the same call - easy
const peopleWhoShouldNotTalk = ["raschiff@cisco.com", "krs3@schiffert.me"]
// DLP POLICY - DLP POLICY - DLP POLICY


var myApp = {
  // webhookinbox 3rd party server to receive our webhooks on who joined - that's convenient since we
  // don't need to use ngrok or a public server
  webhookInboxUrl: "",
  // list of webhook ids so we can remove them at the end
  webhooks: [],
  // id's of people who should not talk
  personIdsWhoShouldNotTalk: [],
  // violating memberships
  memberships2BRemoved: new Set(),

  // this is the data structure we use to store all calls in the system
  // the people itself will be stored as Sets in the map
  // MapEntry -> SetOfCallMemberships
  // the set give us some handy shortcuts, for example if we want to check of the membership was already added
  calls: new Map(),
  // this map stores for each person their callMembershipId
  // even if the person calls in from several devices it will be under 1 callMembershipId
  // it would not work though if the person would join 2 different calls at the same time
  person2CallMembership: new Map(),

  init: function (emailsThatShouldNotTalk) {

    let kickoffPromise = this.deleteAllAccountWebhooks()
      .then(() => this.resolvePeople2Id(emailsThatShouldNotTalk))
      .then(() => this.createWebhookInbox())
      // the view URL is different from the API endpoint to insert events
      .then((webhookinbox) => {
        console.log("http://webhookinbox.com/view/" + webhookinbox.split("/").splice(-2)[0])
      })
      .then(() => this.refreshWebhookInboxRegularly())
      .then(() => this.createWebhooks())
      .then(() => {
        return this.checkWhoCalledInAndHangup()
      })
      .catch(console.log)
  },

  deleteAllAccountWebhooks: function () {

    // removes all webhooks registered by the account token
    return teams.webhooks.list({max: 100})
      .then(w => w.items.map(i => {
        return teams.webhooks.remove(i.id)
      }))
      .then(
        v => {
          return Promise.all(v)
        })
      .catch(console.log)
  },

  setupWebhookData: function () {

    // previously I had this as a promise based function
    // but this is something we can call sychronously

    // sets up the array for the 3 webhooks that we need to register later
    // it's just a helper to get the fields for the webhook setup right
    const wh1 = {
      name: "callJoined",
      resource: "callMemberships",
      event: "created",
      filter: "status=joined",
      targetUrl: this.webhookInboxUrl + 'in/',
      ownedBy: "org"
    }

    // technically speaking it is not necessary to setup the person filter here but it makes the code simpler
    // and more efficient hopefully. If we wanted to control dynamically which people must not talk we could
    // omit the person filter and rather check each incoming callMembership webhook
    if (!this.personIdsWhoShouldNotTalk || this.personIdsWhoShouldNotTalk.length == 0) {
      // we need the people ID's
      // return Promise.reject("need to call resolvePeople2Id before calling setupWebhookData")
      throw new Error('need to call resolvePeople2Id before calling setupWebhookData')
    }

    let webhookSet = this.personIdsWhoShouldNotTalk.map(i => {
      return Object.assign({}, wh1, {filter: `${wh1.filter}&personId=${i}`})
    })
    let wh2 = Object.assign({}, wh1, {event: "updated"})

    const whCallEnded = {
      name: "callEnded",
      resource: "calls",
      event: "updated",
      filter: "status=disconnected",
      targetUrl: this.webhookInboxUrl + 'in/',
      ownedBy: "org"
    }

    webhookSet.push(whCallEnded)

    // the spread operator splits the array into its constituents
    // otherwise we would have an array in an array
    webhookSet.push(...this.personIdsWhoShouldNotTalk.map(i => {
      return Object.assign({}, wh2, {filter: `${wh2.filter}&personId=${i}`})
    }))

    // callMemberships
    // return Promise.resolve(this.webhooks2Add = webhookSet)
    return webhookSet
  },
  createWebhooks: function () {

    // with the array of webhooks data to register we use it
    // to point the Teams API to the webhookinbox URL
    return Promise.all(
      this.setupWebhookData().map(i => {
        return teams.webhooks.create(i)
      }),
    ).then(w => this.webhooks = w).catch(console.log)
  },
  createWebhookInbox: function () {
    // the webhookinbox is just so we don't have to run a server
    // instead we are going to poll for events from it
    // frankly we could also poll from the events API but then it's not so awesome to watch
    // we are going to print out the link to the webhook inbox so you can watch the webhooks coming in
    return got('http://api.webhookinbox.com/create/', {method: 'POST'})
      .then(res => {
        return this.webhookInboxUrl = JSON.parse(res.body).base_url;
      })
  },
  refreshWebhookInboxRegularly: function () {

    // webhookinboxes get destroyd when they don't receive traffic within a fairly short TTL period
    // the way around this is to call /refresh/ in regular intervals
    let url = this.webhookInboxUrl + 'refresh/'

    setInterval(() => {
      got(url, {'method': 'POST'}).then(() => {
        console.log("inbox refreshed")
      }).catch(console.log)
    }, 60 * 1000)

    return Promise.resolve()
  },
  resolvePeople2Id: function (disallowedPeopleArray) {
    // this returns a promise with an array of the peopleId's associated with the peopleWhoShouldNotTalk array,
    // which we setup as email addresses while internally mos API calls work with ID's
    return Promise.all(
      disallowedPeopleArray.map(i =>
        teams.people.list({email: i}).then(p => p.items[0].id)))
      .then(a => {
        return this.personIdsWhoShouldNotTalk = a
      })
  },
  // this is the easier way to do it. the stream produces when a new item arrives
  checkWhoCalledInAndHangup: function () {

    let url = this.webhookInboxUrl + 'stream/'
    let self = this

    // when the stream is opened it comes back with the message '[opened]\n' which we don't want to parse
    highland(got.stream(url)).map(function (x) {
      return x.toString('utf-8').replace('[opened]\n', '')
    }).pipe(ts1).pipe(ts2).on('data', function handleDataRecord(data) {


      if (data.status && data.status == "disconnected") {
        // this is a call ended notification

        // for call membership there is a left, not a disconnected

        // we first remove the call memberships from the array memberships2BRemoved and then we remove the call itself
        // this is needed since we don't have the rights to hanghup on all memberships and they would aggregate
        // alternative we could register another webhook for the membership left and remove that one
        // this is a little trickier since the membershipID is not unique within a call
        // for example if I join a meeting - drop and rejoin I am getting the same membership ID
        let setOfMemberships2BRemoved = self.calls.get(data.callId)

        console.log('call ended memberships2BRemoved')
        console.log(setOfMemberships2BRemoved)

        if (setOfMemberships2BRemoved) {
          // we remove the callMemberships asscoiated with this call from the ones we needed to remove
          let tmp = [...self.memberships2BRemoved].filter(x => !setOfMemberships2BRemoved.has(x))
          self.memberships2BRemoved = new Set(tmp)

          self.calls.delete(data.callId)
          console.log('call ' + +' has ended')
        }
      } else if (self.personIdsWhoShouldNotTalk.includes(data.personId)) {
            // this is a callMembership notification for a person of interest

            let callId = data.callId
            let callMembershipId = data.id
            let status = data.status
            let personId = data.personId


            self.person2CallMembership.set(personId, callMembershipId) // a new call membership will overwrite an
        // old one

            console.log('callid', chalk.green(callId))
            console.log('personId', chalk.green(data.personId))
            console.log('callMembershipId', chalk.green(callMembershipId))
            console.log('status', chalk.green(status))


            // let's check if we have the callId already
            if (self.calls.has(callId)) {
              //get the set and add the person
              self.calls.get(callId).add(callMembershipId) // if the personId is already there, no harm is done - this is
              // a set
            } else {
              self.calls.set(callId, new Set().add(callMembershipId)) // empty set of people
            }
          }


        if (self.checkForDLPDisallowed().size > 1) {
          self.hangupOnViolators().then((v) => {
            console.log('http' + v)
          }).catch(console.log)
        }
    }).on('end', function handleEnd() {
      console.log(chalk.green("stream closed"))
    })
  },
  checkForDLPDisallowed: function () {

    // we don't need this elaborate filtering and checking anymore since we already put only people into the set
    // that should not talk - so we can just check if there is more than 1 person in this call and need to hangup
    // iterate over all calls
    //for (const c of this.calls.keys()) {
    //
    //  this.forbiddenPeopleInCall = this.personIdsWhoShouldNotTalk.filter(x => this.calls.get(c).has(x))
    //
    //  if (this.forbiddenPeopleInCall.length >= 2) {
    //
    //    let tmpArr = this.forbiddenPeopleInCall.map(pid => this.person2CallMembership.get(pid))
    //    tmpArr.forEach(e => this.memberships2BRemoved.add(e))
    //  }
    //}
    for ( let cm  of this.calls.values() ) {
      if ( cm.size > 1 ) {
        // 2 or more forbidden people in same call
        this.memberships2BRemoved = new Set([...this.memberships2BRemoved, ...cm])
        console.log(this.memberships2BRemoved)
      }
    }

    return this.memberships2BRemoved
  },
  hangupOnViolators: function () {

    return Promise.all(
      // map doesn't work with sets
      // but map makes it easier to use Promise.all since forEach doesn't return anything
      // so we convert the set to an array
      // we used a set only to avoid duplicates
      [...this.memberships2BRemoved].map(i => {
        got('https://api.ciscospark.com/v1/call/commands/hangup',
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + process.env.ADMIN_TOKEN,
              'Content-type': 'application/json'
            },
            json: true,
            body: {
              "callMembershipId": i
            }
          })
          .then(() => {
            console.log('did hangup on ' + i + ' successfully')
            try {
              let tmp = [...this.memberships2BRemoved].filter(x => x != i)
              this.memberships2BRemoved = new Set(tmp)
            } catch ( e ) {
              console.log(e)
            }
            return this.remindViolatorsInDirectMessage(i)
          })
          .catch(() => {
            console.log("could not hangup on membershipId " + i)
          })
      })
    )
  },
  remindViolatorsInDirectMessage: function (membershipId) {
    // reverse mapping to personId
    console.log('RALF4')
    console.log("remind violators in direct message")
    for (const [k, v] of this.person2CallMembership) {
      if (v == membershipId) {
        console.log('personId ' + k )
        return teams.messages.create({toPersonId: k, text: "Your call has ended due to a policy violation"})
      }
    }
  }
}


myApp.init(peopleWhoShouldNotTalk)
